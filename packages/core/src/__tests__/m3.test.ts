import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createApp } from "../api/server.js";
import { policySchema } from "../config.js";
import { pluginDataDir, resolveFsGrants } from "../host/manifest.js";
import { resolvePaths } from "../paths.js";
import type { Sinty } from "../sinty.js";
import { boot, tempHome, type ScriptStep } from "./helpers.js";

const openPolicy = policySchema.parse({ tools: { "kanban.*": "allow" } });

async function withApp(script: ScriptStep[], plugins: string[], fn: (ctx: { sinty: Sinty; app: ReturnType<typeof createApp>; auth: Record<string, string>; home: string }) => Promise<void>, config = {}): Promise<void> {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, script, { plugins: ["fake-provider", ...plugins], policy: openPolicy, config });
  try {
    const app = createApp(sinty);
    const auth = { authorization: `Bearer ${sinty.secrets.get("api.token")!}`, "content-type": "application/json" };
    await fn({ sinty, app, auth, home });
  } finally {
    await sinty.stop();
    cleanup();
  }
}

async function until<T>(fn: () => T | Promise<T>, what: string, ms = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

test("plugin routes: auth, public routes, params, header stripping, streaming, errors", async () => {
  await withApp([], ["web-routes"], async ({ app, auth }) => {
    assert.equal((await app.request("/p/web-routes/echo/x")).status, 401);
    assert.equal(await (await app.request("/p/web-routes/public")).text(), "open");

    const token = auth.authorization!.slice(7);
    const echo = (await (
      await app.request(`/p/web-routes/echo/alice?token=${token}&q=1`, { headers: { cookie: "a=b", "x-custom": "yes" } })
    ).json()) as Record<string, unknown>;
    assert.deepEqual(echo, { name: "alice", query: { q: "1" }, authorization: null, cookie: null, custom: "yes" });

    const res = await app.request("/p/web-routes/stream", { headers: auth });
    assert.equal(res.headers.get("x-from"), "plugin");
    assert.equal(await res.text(), "one two three");

    assert.equal((await app.request("/p/web-routes/nope", { headers: auth })).status, 404);
    assert.equal((await app.request("/p/no-such-plugin/x", { headers: auth })).status, 404);
    assert.equal((await app.request("/p/web-routes/boom", { headers: auth })).status, 502);
  });
});

test("plugin agent access: scopes are enforced; $DATA is the plugin's own folder", async () => {
  await withApp([], ["web-routes"], async ({ sinty, app, auth, home }) => {
    sinty.agent.createSession({ title: "visible" });
    const list = (await (await app.request("/p/web-routes/sessions", { headers: auth })).json()) as { title: string; activeTurn: unknown }[];
    assert.equal(list[0]?.title, "visible");
    assert.equal(list[0]?.activeTurn, null);

    const denied = await app.request("/p/web-routes/create", { method: "POST", headers: auth });
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as { code: string }).code, "agent_denied");

    const wrote = (await (await app.request("/p/web-routes/files/a/b", { method: "POST", headers: auth, body: "hi" })).json()) as { rest: string; dataDir: string };
    const paths = resolvePaths(home);
    assert.equal(wrote.rest, "a/b");
    assert.equal(wrote.dataDir, pluginDataDir(paths, "web-routes"));
    assert.equal(readFileSync(join(wrote.dataDir, "note.txt"), "utf8"), "hi");
  });

  const { home, cleanup } = tempHome();
  try {
    const paths = resolvePaths(home);
    const manifest = { name: "nosy", version: "0.0.1", description: "x", kinds: ["tool"], runtime: "node", permissions: { fs: { read: [join(paths.data, "kanban")] } } } as const;
    assert.throws(() => resolveFsGrants(paths, { dir: join(home, "x"), bundled: false, manifest: manifest as never }), /own data folder/);
  } finally {
    cleanup();
  }
});

test("static UI is served only from non-editable plugins, with a CSP", async () => {
  await withApp([], ["web-ui", "web-ui-open"], async ({ app }) => {
    const index = await app.request("/ui/web-ui/");
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(await index.text(), /fixture ui/);
    const asset = await app.request("/ui/web-ui/assets/app.js");
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);
    assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
    assert.match(await (await app.request("/ui/web-ui/some/client/route")).text(), /fixture ui/);
    assert.doesNotMatch(await (await app.request("/ui/web-ui/%2e%2e/sinty.plugin.json")).text(), /"kinds"/);
    assert.equal((await app.request("/ui/web-ui-open/")).status, 404);
    const root = await app.request("/");
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/ui/web-ui/");
  }, { server: { host: "127.0.0.1", port: 0, token: "secret://api.token", ui: "web-ui" } });
});

test("pending approvals and the supervisor panel are visible through the API", async () => {
  await withApp([{ toolCalls: [{ name: "side.effect", args: { line: "x" } }] }, { text: "done" }], ["test-tools"], async ({ sinty, app, auth }) => {
    const s = sinty.agent.createSession({ title: "p" });
    sinty.agent.send(s.id, "go");
    const pending = await until(async () => ((await (await app.request("/v1/pending", { headers: auth })).json()) as { pending: { approvals: { tool: string; callId: string }[] }[] }).pending[0], "a pending approval");
    assert.equal(pending.approvals[0]?.tool, "side.effect");
    const one = (await (await app.request(`/v1/sessions/${s.id}`, { headers: auth })).json()) as { pending: { reason: string } | null; activeTurn: { status: string } | null };
    assert.equal(one.pending?.reason, "approval");
    assert.equal(one.activeTurn?.status, "blocked");

    await app.request(`/v1/sessions/${s.id}/approvals/${pending.approvals[0]!.callId}`, { method: "POST", headers: auth, body: JSON.stringify({ decision: "approve" }) });
    await sinty.agent.idle();
    assert.equal(((await (await app.request(`/v1/sessions/${s.id}/pending`, { headers: auth })).json()) as { pending: unknown }).pending, null);

    const sup = (await (await app.request("/v1/supervisor", { headers: auth })).json()) as { enabled: boolean; events: unknown[]; incidents: unknown[]; patches: unknown[] };
    assert.equal(sup.enabled, true);
    assert.ok(Array.isArray(sup.events) && Array.isArray(sup.incidents) && Array.isArray(sup.patches));
  });
});

test("kanban: a card for the agent runs in its own session and lands in review", async () => {
  await withApp([{ text: "card done" }], ["kanban"], async ({ sinty, app, auth }) => {
    const created = (await (
      await app.request("/p/kanban/cards", { method: "POST", headers: auth, body: JSON.stringify({ title: "Write a haiku", column: "todo", assignee: "agent" }) })
    ).json()) as { id: string };
    const card = await until(async () => {
      const board = (await (await app.request("/p/kanban/board", { headers: auth })).json()) as { cards: { id: string; column: string; sessionId: string | null }[] };
      const c = board.cards.find((x) => x.id === created.id);
      return c?.column === "review" ? c : undefined;
    }, "the card in review");
    const events = sinty.journal.events(card.sessionId!);
    assert.equal(events.find((e) => e.type === "message.agent")?.data && (events.find((e) => e.type === "message.agent")!.data as { text: string }).text, "card done");
    assert.match((events.find((e) => e.type === "message.user")!.data as { text: string }).text, /Write a haiku/);
  });
});

test("server-openai-api: chat completions, plain and streamed, continue one session", async () => {
  await withApp([{ text: "first answer" }, { text: "second answer" }], ["server-openai-api"], async ({ sinty, app, auth }) => {
    const models = (await (await app.request("/p/server-openai-api/v1/models", { headers: auth })).json()) as { data: { id: string }[] };
    assert.ok(models.data.length > 0);

    const plain = (await (
      await app.request("/p/server-openai-api/v1/chat/completions", { method: "POST", headers: { ...auth, "x-sinty-session": "" }, body: JSON.stringify({ model: "sinty", user: "u1", messages: [{ role: "user", content: "hi" }] }) })
    ).json()) as { choices: { message: { content: string } }[]; sinty: { session_id: string } };
    assert.equal(plain.choices[0]?.message.content, "first answer");

    const streamed = await (
      await app.request("/p/server-openai-api/v1/chat/completions", { method: "POST", headers: auth, body: JSON.stringify({ model: "sinty", user: "u1", stream: true, messages: [{ role: "user", content: "again" }] }) })
    ).text();
    const content = streamed
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => (JSON.parse(l.slice(6)) as { choices: { delta: { content?: string } }[] }).choices[0]?.delta.content ?? "")
      .join("");
    assert.equal(content, "second answer");
    assert.match(streamed, /data: \[DONE\]/);
    assert.equal(sinty.journal.events(plain.sinty.session_id).filter((e) => e.type === "turn.completed").length, 2);
  });
});

test("server-mcp: initialize, tools/list and sinty_ask", async () => {
  await withApp([{ text: "mcp answer" }], ["server-mcp"], async ({ app, auth }) => {
    const rpc = async (body: unknown): Promise<Response> => app.request("/p/server-mcp/mcp", { method: "POST", headers: { ...auth, accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
    const init = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })).json()) as { result: { protocolVersion: string } };
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);

    const list = (await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: { name: string; inputSchema: { type: string } }[] } };
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ["sinty_ask", "sinty_session_messages", "sinty_sessions"]);
    assert.equal(list.result.tools[0]?.inputSchema.type, "object");

    const call = (await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "sinty_ask", arguments: { message: "hello" } } })).json()) as {
      result: { content: { text: string }[]; structuredContent: { session_id: string; status: string } };
    };
    assert.equal(call.result.structuredContent.status, "completed");
    assert.match(call.result.content[0]!.text, /mcp answer/);

    const bad = (await (await rpc({ jsonrpc: "2.0", id: 4, method: "nope" })).json()) as { error: { code: number } };
    assert.equal(bad.error.code, -32601);
  });
});

test("provider-openai-responses: streams text and tool calls from the Responses API", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    // The core asks GET /models once on start for context windows (context-window.ts); these servers list none.
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"data":[]}');
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      const hasOutput = (body.input as { type?: string }[]).some((i) => i.type === "function_call_output");
      const events = hasOutput
        ? [
            { type: "response.output_text.delta", delta: "got " },
            { type: "response.output_text.delta", delta: "it" },
            { type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 4 } } },
          ]
        : [
            { type: "response.reasoning_summary_text.delta", delta: "thinking" },
            { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "echo__say", arguments: '{"text":"ping"}' } },
            { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } } } },
          ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const { home, cleanup } = tempHome();
  const { Sinty } = await import("../sinty.js");
  const { FIXTURES } = await import("./helpers.js");
  const sinty = new Sinty({
    home,
    config: {
      providers: { oai: { protocol: "openai-responses", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test-key" } },
      models: { default: "oai/gpt-test", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
      plugins: { enabled: ["provider-openai-responses", "test-tools"], config: {}, searchPaths: [FIXTURES] },
    },
    policy: openPolicy,
  });
  try {
    const { failedPlugins } = await sinty.start();
    assert.deepEqual(failedPlugins, []);
    const s = sinty.agent.createSession({});
    sinty.agent.send(s.id, "say ping");
    await sinty.agent.idle();
    const events = sinty.journal.events(s.id);
    assert.equal((events.find((e) => e.type === "tool.call.completed")?.data as { result: unknown }).result, "ping");
    assert.equal((events.findLast((e) => e.type === "message.agent")?.data as { text: string }).text, "got it");
    assert.equal(bodies[0]?.store, false);
    assert.equal(bodies[0]?.stream, true);
    assert.equal(typeof bodies[0]?.instructions, "string");
    const second = bodies[1]?.input as { type?: string; call_id?: string; output?: string }[];
    assert.ok(second.some((i) => i.type === "function_call" && i.call_id === "call_1"));
    assert.ok(second.some((i) => i.type === "function_call_output" && i.call_id === "call_1"));
  } finally {
    await sinty.stop();
    server.close();
    cleanup();
  }
});

test("data folders are created under the home", () => {
  const { home, cleanup } = tempHome();
  try {
    assert.ok(existsSync(resolvePaths(home).data));
  } finally {
    cleanup();
  }
});
