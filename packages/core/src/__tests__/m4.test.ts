import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../api/server.js";
import { policySchema } from "../config.js";
import { pluginDataDir } from "../host/manifest.js";
import { resolvePaths } from "../paths.js";
import { boot, FIXTURES, tempHome, type ScriptStep } from "./helpers.js";

const policy = policySchema.parse({
  tools: { "delegate.run": "allow", "syntet.record_usage": "allow", "kanban.*": "allow" },
  net: { allow: ["127.0.0.1", "localhost"] },
});

function listen(): Promise<{ server: Server; url: string }> {
  const server = createServer();
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

async function up(script: ScriptStep[], names: string[], config: Record<string, Record<string, unknown>>, env: Record<string, string>) {
  const { home, cleanup } = tempHome();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const sinty = await boot(home, script, {
    policy,
    plugins: ["fake-provider", ...names],
    config: { plugins: { enabled: ["fake-provider", ...names], config, searchPaths: [FIXTURES] } },
  });
  const app = createApp(sinty);
  const auth = { authorization: `Bearer ${sinty.secrets.get("api.token")!}`, "content-type": "application/json" };
  return { sinty, app, auth, home, cleanup: async () => { await sinty.stop(); for (const k of Object.keys(env)) delete process.env[k]; cleanup(); } };
}

test("channel-webhook and channel-voice return the agent text", async () => {
  const ctx = await up([{ text: "hook ok" }], ["channel-webhook", "channel-voice"], {}, {});
  try {
    const hook = (await (await ctx.app.request("/p/channel-webhook/hook", { method: "POST", headers: ctx.auth, body: JSON.stringify({ message: "hi", chat_id: "c1" }) })).json()) as { text: string; session_id: string };
    assert.equal(hook.text, "hook ok");
    const again = (await (await ctx.app.request("/p/channel-webhook/hook", { method: "POST", headers: ctx.auth, body: JSON.stringify({ text: "next", chat_id: "c1" }) })).json()) as { session_id: string; text: string };
    assert.equal(again.session_id, hook.session_id);
    assert.equal(again.text, "fallthrough 1");
    const voice = (await (await ctx.app.request("/p/channel-voice/turn", { method: "POST", headers: ctx.auth, body: JSON.stringify({ text: "say" }) })).json()) as { text: string };
    assert.equal(voice.text, "hook ok");
  } finally {
    await ctx.cleanup();
  }
});

test("telegram webhook checks the secret and sends the answer", async () => {
  const hits: { path: string; body: string }[] = [];
  const { server, url } = await listen();
  server.on("request", (req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits.push({ path: req.url ?? "", body: raw });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  const ctx = await up([{ text: "from bot" }], ["channel-telegram"], { "channel-telegram": { apiBase: url } }, { SINTY_SECRET_TELEGRAM_SECRET: "sec", SINTY_SECRET_TELEGRAM_BOT: "bot" });
  try {
    assert.equal((await ctx.app.request("/p/channel-telegram/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    const ok = await ctx.app.request("/p/channel-telegram/telegram", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "sec" },
      body: JSON.stringify({ message: { chat: { id: 7 }, text: "ping" } }),
    });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { delivered: boolean }).delivered, true);
    assert.match(hits[0]?.path ?? "", /\/botbot\/sendMessage/);
    assert.match(hits[0]?.body ?? "", /from bot/);
  } finally {
    server.close();
    await ctx.cleanup();
  }
});

test("a2a message/send and syntet.whoami", async () => {
  const { server, url } = await listen();
  server.on("request", (req, res) => {
    const auth = req.headers.authorization;
    res.writeHead(auth === "Bearer site" ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: 1, auth: auth ?? null }));
  });
  const ctx = await up(
    [{ text: "a2a answer" }],
    ["server-a2a", "syntet"],
    { syntet: { baseUrl: url } },
    { SINTY_SECRET_SYNTET_TOKEN: "site" },
  );
  try {
    const card = await ctx.app.request("/p/server-a2a/.well-known/agent-card.json", { headers: ctx.auth });
    assert.equal(card.status, 200);
    assert.equal(((await card.json()) as { name: string }).name, "Sinty");
    const sent = (await (await ctx.app.request("/p/server-a2a/a2a", { method: "POST", headers: ctx.auth, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { parts: [{ kind: "text", text: "task" }] } } }) })).json()) as { result: { status: { state: string }; artifacts: { parts: { text: string }[] }[] } };
    assert.equal(sent.result.status.state, "completed");
    assert.equal(sent.result.artifacts[0]?.parts[0]?.text, "a2a answer");
    await ctx.cleanup();
    const tool = await up([{ toolCalls: [{ name: "syntet.whoami", args: {} }] }, { text: "seen" }], ["syntet"], { syntet: { baseUrl: url } }, { SINTY_SECRET_SYNTET_TOKEN: "site" });
    try {
      const s = tool.sinty.agent.createSession({ title: "tools" });
      tool.sinty.agent.send(s.id, "who");
      await tool.sinty.agent.idle();
      const done = tool.sinty.journal.events(s.id).find((e) => e.type === "tool.call.completed");
      assert.deepEqual((done?.data as { result: { id: number } }).result, { id: 1, auth: "Bearer site" });
    } finally {
      await tool.cleanup();
    }
  } finally {
    server.close();
  }
});

test("delegate runs only a configured program", async () => {
  const ctx = await up(
    [{ toolCalls: [{ name: "delegate.run", args: { program: "echo", prompt: "delegated" } }] }, { text: "done" }],
    ["delegate"],
    { delegate: { commands: { echo: [process.execPath, "-e", "process.stdout.write(String(process.argv.at(-1) ?? ''))"] }, timeoutMs: 15000 } },
    {},
  );
  try {
    const s = ctx.sinty.agent.createSession({});
    ctx.sinty.agent.send(s.id, "go");
    await ctx.sinty.agent.idle();
    const result = ctx.sinty.journal.events(s.id).find((e) => e.type === "tool.call.completed")?.data as { result: string };
    assert.equal(result.result, "delegated");
  } finally {
    await ctx.cleanup();
  }
});

test("herdr and otel record a turn", async () => {
  const ctx = await up([{ text: "traced" }], ["herdr", "otel"], {}, {});
  try {
    const s = ctx.sinty.agent.createSession({});
    ctx.sinty.agent.send(s.id, "hi");
    await ctx.sinty.agent.idle();
    const paths = resolvePaths(ctx.home);
    const states = readFileSync(join(pluginDataDir(paths, "herdr"), "states.jsonl"), "utf8");
    assert.match(states, /working/);
    const spans = readFileSync(join(pluginDataDir(paths, "otel"), "spans.jsonl"), "utf8");
    assert.match(spans, /turn.completed/);
  } finally {
    await ctx.cleanup();
  }
});
