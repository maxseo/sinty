import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ChatMessage, ContextSnapshot } from "@sinty/sdk";
import { createApp } from "../api/server.js";
import type { SintyConfig } from "../config.js";
import { boot, FIXTURES, tempHome } from "./helpers.js";

function cfg(plugins: string[], inspect: string[]): Partial<SintyConfig> {
  return {
    providers: { rec: { protocol: "rec", options: { script: {} } } },
    models: { default: "rec/main", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
    plugins: { enabled: ["recording-provider", ...plugins], config: {}, searchPaths: [FIXTURES], inspect },
  };
}

const chatRequests = (home: string): { messages: ChatMessage[] }[] => {
  const file = join(home, "data", "recording-provider", "requests.jsonl");
  const rows = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { messages?: ChatMessage[] }) : [];
  return rows.filter((r): r is { messages: ChatMessage[] } => Array.isArray(r.messages));
};

test("context-inspector plugin: tab listed by /v1/plugins, page public with a no-network CSP, data behind the token", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { config: cfg(["context-inspector"], ["context-inspector"]), plugins: [] });
  try {
    const app = createApp(sinty);
    const auth = { authorization: `Bearer ${sinty.secrets.get("api.token")!}` };
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "hello inspector");
    await sinty.agent.idle();

    const { plugins } = (await (await app.request("/v1/plugins", { headers: auth })).json()) as { plugins: { name: string; tabs: { id: string; title: string; src: string; placement: string }[]; inspector: boolean }[] };
    const ci = plugins.find((p) => p.name === "context-inspector")!;
    // placement "session": the Web UI shows it in the chat header, not in the sidebar.
    assert.deepEqual(ci.tabs, [{ id: "context", title: "Контекст", src: "/p/context-inspector/tab", placement: "session" }]);
    assert.equal(ci.inspector, true);
    assert.deepEqual(plugins.find((p) => p.name === "recording-provider")!.tabs, []);

    const page = await app.request("/p/context-inspector/tab");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'none'/);
    assert.match(await page.text(), /tab\/1/);
    assert.equal((await app.request("/p/context-inspector/sessions")).status, 401);
    assert.equal((await app.request(`/p/context-inspector/snapshots?session=${s.id}`)).status, 401);

    let list: { id: string }[] = [];
    for (let i = 0; i < 100 && !list.length; i++) {
      list = ((await (await app.request(`/p/context-inspector/snapshots?session=${s.id}`, { headers: auth })).json()) as { snapshots: { id: string }[] }).snapshots;
      if (!list.length) await sleep(20);
    }
    assert.equal(list.length, 1);
    const sessions = (await (await app.request("/p/context-inspector/sessions", { headers: auth })).json()) as { sessions: { sessionId: string; steps: number }[] };
    assert.deepEqual(sessions.sessions.map((x) => [x.sessionId, x.steps]), [[s.id, 1]]);
    const snap = (await (await app.request(`/p/context-inspector/snapshots/${list[0]!.id}`, { headers: auth })).json()) as ContextSnapshot;
    assert.deepEqual(snap.messages, chatRequests(home)[0]!.messages);
    assert.equal((await app.request("/p/context-inspector/snapshots/nope", { headers: auth })).status, 404);
  } finally {
    await sinty.stop();
    cleanup();
  }
});
