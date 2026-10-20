import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import type { SintyEvent } from "@sinty/sdk";
import { createApp } from "../api/server.js";
import { configSchema, effectiveBudget, policySchema, type SintyConfig } from "../config.js";
import { Journal } from "../journal.js";
import { resolvePaths } from "../paths.js";
import { boot, FIXTURES, tempHome, type ScriptStep } from "./helpers.js";

const allow = (turn: Record<string, number> = {}) => policySchema.parse({ defaults: { none: "allow", read: "allow", write: "allow", external: "allow" }, budgets: { turn } });
const supervisor = (s: Record<string, unknown>): SintyConfig["supervisor"] => configSchema.parse({ supervisor: s }).supervisor;
const PLUGINS = ["fake-provider", "test-tools", "flaky"];
const blockedReason = (events: SintyEvent[]): string | undefined => (events.findLast((e) => e.type === "turn.blocked")?.data as { reason?: string } | undefined)?.reason;

test("effectiveBudget: config.yaml supervisor.budget wins over policy.yaml, 0 means no limit", () => {
  const policy = allow({ steps: 60, tokens: 600000, seconds: 1200 });
  const base = configSchema.parse({});
  assert.deepEqual(effectiveBudget(base, policy), { steps: 60, tokens: 600000, seconds: 1200, count: "weighted", cachedWeight: 0.1, warnAt: 0.8, stop: true });
  const own = configSchema.parse({ supervisor: { budget: { tokens: 0, steps: 10, count: "all" } } });
  assert.deepEqual(effectiveBudget(own, policy), { steps: 10, seconds: 1200, count: "all", cachedWeight: 0.1, warnAt: 0.8, stop: true });
});

test("budget: cached prompt tokens are weighted, so a cached turn finishes; counting all tokens stops it", async () => {
  const cachedCall: ScriptStep = { toolCalls: [{ name: "echo__say", args: { text: "x" } }], usage: { inputTokens: 600, outputTokens: 5, cachedTokens: 590 } };
  const script: ScriptStep[] = [cachedCall, { ...cachedCall, toolCalls: [{ name: "echo__say", args: { text: "y" } }] }, { text: "done", usage: { inputTokens: 600, outputTokens: 5, cachedTokens: 590 } }];
  for (const [count, finishes] of [["weighted", true], ["all", false]] as const) {
    const { home, cleanup } = tempHome();
    const sinty = await boot(home, script, { policy: allow({ tokens: 1000 }), plugins: PLUGINS, config: { supervisor: supervisor({ budget: { count } }) } });
    try {
      const s = sinty.agent.createSession();
      sinty.agent.send(s.id, "go");
      await sinty.agent.idle();
      const events = sinty.journal.events(s.id);
      assert.equal(blockedReason(events) === "budget", !finishes, `${count}: ${JSON.stringify(events.filter((e) => e.type === "turn.blocked").map((e) => e.data))}`);
      if (!finishes) {
        // «Продолжить» after a budget stop still works.
        sinty.agent.send(s.id, "continue");
        await sinty.agent.idle();
        assert.ok(sinty.journal.events(s.id).some((e) => e.type === "turn.completed"));
      }
    } finally {
      await sinty.stop();
      cleanup();
    }
  }
});

test("budget: stop false only warns", async () => {
  const call: ScriptStep = { toolCalls: [{ name: "echo__say", args: { text: "x" } }] };
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [call, { toolCalls: [{ name: "echo__say", args: { text: "y" } }] }, { text: "finished" }], { policy: allow({ steps: 2 }), plugins: PLUGINS, config: { supervisor: supervisor({ budget: { stop: false } }) } });
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "go");
    await sinty.agent.idle();
    const events = sinty.journal.events(s.id);
    assert.equal(blockedReason(events), undefined);
    assert.equal((events.findLast((e) => e.type === "message.agent")?.data as { text: string }).text, "finished");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("settings sections: supervisor and plugin sections listed; saving writes config.yaml and applies live", async () => {
  const { home, cleanup } = tempHome();
  const paths = resolvePaths(home);
  writeFileSync(paths.config, `${readFileSync(paths.config, "utf8")}\n# my note stays\n`);
  const sinty = await boot(home, [], {
    config: {
      providers: { rec: { protocol: "rec", options: { script: {} } } },
      models: { default: "rec/main", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
      plugins: { enabled: ["recording-provider", "context-inspector"], config: {}, searchPaths: [FIXTURES], inspect: ["context-inspector"] },
    },
    plugins: [],
  });
  try {
    const app = createApp(sinty);
    const auth = { authorization: `Bearer ${sinty.secrets.get("api.token")!}`, "content-type": "application/json" };
    const { sections } = (await (await app.request("/v1/settings/sections", { headers: auth })).json()) as { sections: { id: string; title: string; values: Record<string, unknown>; defaults: Record<string, unknown>; restart: boolean }[] };
    const sup = sections.find((s) => s.id === "supervisor")!;
    assert.equal(sup.title, "Супервизор");
    assert.equal(sup.values["budget.count"], "weighted");
    assert.equal(sup.values["checks.loop"], true);
    assert.equal(sup.values["budget.tokens"], undefined, "unset: from policy.yaml");
    assert.equal(sup.defaults["budget.tokens"], 600000);
    const ci = sections.find((s) => s.id === "plugin.context-inspector")!;
    assert.deepEqual(ci.values, { keep: 100, maxMb: 64 });
    assert.equal(ci.restart, true);

    const put = (id: string, values: Record<string, unknown>) => app.request(`/v1/settings/sections/${id}`, { method: "PUT", headers: auth, body: JSON.stringify({ values }) });
    const ok = await put("supervisor", { "budget.tokens": 2000000, "budget.count": "uncached", "checks.loop": false, maxNoticesPerDetector: 3 });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { restart: boolean }).restart, false);
    assert.equal(sinty.config.supervisor.budget.tokens, 2000000);
    assert.equal(sinty.config.supervisor.checks.loop, false);
    assert.equal(effectiveBudget(sinty.config, sinty.policy).count, "uncached");
    const yaml = readFileSync(paths.config, "utf8");
    assert.match(yaml, /# my note stays/);
    assert.match(yaml, /tokens: 2000000/);
    assert.match(yaml, /count: uncached/);

    assert.equal((await put("supervisor", { "budget.tokens": null })).status, 200);
    assert.equal(sinty.config.supervisor.budget.tokens, undefined);
    assert.equal((await put("supervisor", { loopThreshold: 0 })).status, 400);
    assert.equal((await put("supervisor", { "budget.count": "dollars" })).status, 400);
    assert.equal((await put("supervisor", { nope: 1 })).status, 400);
    assert.equal((await put("missing", { a: 1 })).status, 400);

    assert.equal((await put("plugin.context-inspector", { keep: 7 })).status, 200);
    assert.match(readFileSync(paths.config, "utf8"), /context-inspector:\s*\n\s+keep: 7/);
    assert.equal(sinty.config.plugins.config["context-inspector"]?.keep, 7);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("incidents: stored typed text and secrets are masked on start; /v1/supervisor filters by chat", async () => {
  const { home, cleanup } = tempHome();
  const typed = "Tr0ub4dor-zz";
  const j = new Journal(resolvePaths(home).journal);
  j.addIncident({ id: "inc_old", tool: "web.interact", code: "not_found", message: "element not found", fixSummary: `fixed with {"url":"https://x.test","actions":[{"type":"type","selector":"#pw","text":"${typed}"}],"token":"tok-123456"}` });
  j.close();
  const sinty = await boot(home, [{ toolCalls: [{ name: "flaky__get", args: {} }] }, { text: "ok" }], { policy: allow(), plugins: PLUGINS });
  try {
    const [inc] = sinty.journal.incidents();
    assert.ok(inc && !inc.fixSummary.includes(typed) && !inc.fixSummary.includes("tok-123456"), inc?.fixSummary);
    const app = createApp(sinty);
    const auth = { authorization: `Bearer ${sinty.secrets.get("api.token")!}` };
    const noisy = sinty.agent.createSession();
    sinty.agent.send(noisy.id, "get it");
    await sinty.agent.idle();
    const quiet = sinty.agent.createSession();
    const get = async (q: string) => (await (await app.request(`/v1/supervisor${q}`, { headers: auth })).json()) as { events: SintyEvent[]; incidents: unknown[] };
    assert.ok((await get(`?sessionId=${noisy.id}`)).events.length > 0);
    const none = await get(`?sessionId=${quiet.id}`);
    assert.equal(none.events.length, 0);
    assert.equal(none.incidents.length, 0);
    assert.ok((await get("")).incidents.length >= 1, "all chats: the old incident is listed");
    assert.ok(!JSON.stringify(await get("")).includes(typed));
  } finally {
    await sinty.stop();
    cleanup();
  }
});
