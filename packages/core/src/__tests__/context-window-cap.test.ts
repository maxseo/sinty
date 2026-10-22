import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatMessage, ContextSnapshot, SintyEvent } from "@sinty/sdk";
import { createApp } from "../api/server.js";
import { configSchema, type SintyConfig } from "../config.js";
import { compactCap, compactPoint, DEFAULT_COMPACT_CAP } from "../context-window.js";
import type { Sinty } from "../sinty.js";
import { boot, FIXTURES, tempHome } from "./helpers.js";

/** Compaction cap and the fallback window check (docs/journal/2026-10-22-context-window.md, follow-up). */

const memory = (extra: Record<string, unknown>) => configSchema.parse({ memory: extra }).memory;

test("compaction point: min(65% of the window, memory.compactCapTokens); default 150000, 0 or null = no cap", () => {
  const cfg = (m: Record<string, unknown>) => ({ memory: memory(m) }) as SintyConfig;
  assert.equal(compactCap(cfg({})), DEFAULT_COMPACT_CAP);
  assert.equal(DEFAULT_COMPACT_CAP, 150_000);
  assert.equal(compactCap(cfg({ compactCapTokens: 0 })), undefined);
  assert.equal(compactCap(cfg({ compactCapTokens: null })), undefined);
  assert.deepEqual(compactPoint(1_000_000, 150_000), { tokens: 150_000, by: "cap", cap: 150_000 });
  assert.deepEqual(compactPoint(128_000, 150_000), { tokens: 83_200, by: "window", cap: 150_000 });
  assert.deepEqual(compactPoint(1_000_000, undefined), { tokens: 650_000, by: "window" });
  assert.throws(() => memory({ compactCapTokens: -1 }));
});

function recConfig(providers: Record<string, unknown>, extra: Partial<SintyConfig> = {}): Partial<SintyConfig> {
  return {
    providers: providers as SintyConfig["providers"],
    models: { default: "rec/big", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000, contextWindows: { "rec/big": 1_000_000 } },
    plugins: { enabled: ["recording-provider", "test-tools"], config: {}, searchPaths: [FIXTURES] },
    ...extra,
  };
}
const rec = (options: Record<string, unknown> = {}) => ({ protocol: "rec", options: { summary: { summary: "Earlier questions.", facts: [] }, ...options } });

async function talk(sinty: Sinty, turns: number, sessionId?: string): Promise<SintyEvent[]> {
  const s = sessionId ?? sinty.agent.createSession().id;
  for (let i = 0; i < turns; i++) {
    sinty.agent.send(s, `question ${i}: ${"padding ".repeat(30)}`);
    await sinty.agent.idle();
  }
  return sinty.journal.events(s);
}
const folds = (events: SintyEvent[]): number => events.filter((e) => e.type === "memory.compacted").length;

test("compaction cap: a 1M window folds at the cap, not at 650k; cap 0 restores 65% of the window", async () => {
  const run = async (cap: number | undefined): Promise<number> => {
    const { home, cleanup } = tempHome();
    const mem = { ...memory(cap === undefined ? {} : { compactCapTokens: cap }) };
    const sinty = await boot(home, [], { config: recConfig({ rec: rec() }, { memory: mem }), plugins: ["recording-provider", "test-tools"] });
    try {
      return folds(await talk(sinty, 40));
    } finally {
      await sinty.stop();
      cleanup();
    }
  };
  assert.ok((await run(3000)) >= 1, "40 padded turns pass a 3000-token cap");
  assert.equal(await run(0), 0, "no cap: 65% of 1M is far away");
  assert.equal(await run(undefined), 0, "default cap 150000 is far away too");
});

test("compaction cap: Settings section «Память и контекст» edits memory.compactCapTokens live; the snapshot says which threshold applies", async () => {
  const { home, cleanup } = tempHome();
  const config = recConfig({ rec: rec() });
  config.plugins = { enabled: ["recording-provider", "test-tools", "inspect-test"], config: {}, searchPaths: [FIXTURES], inspect: ["inspect-test"] } as SintyConfig["plugins"];
  const sinty = await boot(home, [], { config, plugins: ["recording-provider", "test-tools", "inspect-test"] });
  try {
    const app = createApp(sinty);
    const auth = { authorization: `Bearer ${sinty.secrets.get("api.token")!}`, "content-type": "application/json" };
    const list = (await (await app.request("/v1/settings/sections", { headers: auth })).json()) as { sections: { id: string; owner: string; defaults: Record<string, unknown>; fields: { key: string; help?: string }[] }[] };
    const mem = list.sections.find((s) => s.id === "memory")!;
    assert.equal(mem.owner, "core");
    assert.equal(mem.defaults.compactCapTokens, 150000);
    assert.match(mem.fields[0]!.help ?? "", /65% окна/);

    await talk(sinty, 1);
    const put = await app.request("/v1/settings/sections/memory", { method: "PUT", headers: auth, body: JSON.stringify({ values: { compactCapTokens: 50000 } }) });
    assert.equal(put.status, 200);
    assert.equal(sinty.config.memory.compactCapTokens, 50000, "applied without a restart");
    assert.match(readFileSync(sinty.paths.config, "utf8"), /compactCapTokens: 50000/);
    await talk(sinty, 1);
    assert.equal((await app.request("/v1/settings/sections/memory", { method: "PUT", headers: auth, body: JSON.stringify({ values: { compactCapTokens: -5 } }) })).status, 400);
    assert.equal((await app.request("/v1/settings/sections/memory", { method: "PUT", headers: auth, body: JSON.stringify({ values: { compactCapTokens: 0 } }) })).status, 200);
    await talk(sinty, 1);

    const snaps = readFileSync(join(home, "data", "inspect-test", "snapshots.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as ContextSnapshot);
    assert.deepEqual(snaps.map((s) => [s.window!.compactAt, s.window!.compactBy]), [[150000, "cap"], [50000, "cap"], [650000, "window"]]);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

/** Six turns, each with a 40-line tool result (~1400 tokens), then the primary goes down. */
function bigToolScript(turns: number): Record<string, unknown> {
  const script: Record<string, unknown> = {};
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}: ${"tool output ".repeat(12)}`).join("\n");
  for (let i = 0; i < turns; i++) script[`question ${i}: ${"padding ".repeat(30)}`] = [{ toolCalls: [{ name: "echo.say", args: { text: lines } }] }, { text: `answer ${i}` }];
  return script;
}

function requests(home: string): { model: string; messages: ChatMessage[] }[] {
  return readFileSync(join(home, "data", "recording-provider", "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { model: string; messages: ChatMessage[] }).filter((r) => r.model);
}

test("fallback window: a smaller fallback gets old tool results trimmed for that request only; the primary prompt is untouched", async () => {
  const { home, cleanup } = tempHome();
  const script = bigToolScript(6);
  const sinty = await boot(home, [], {
    config: recConfig({ rec: rec({ script }), small: rec({ script }) }, {}),
    plugins: ["recording-provider", "test-tools"],
  });
  try {
    const s = sinty.agent.createSession().id;
    await talk(sinty, 6, s);
    const full = requests(home).at(-1)!;
    const fullSize = JSON.stringify(full.messages).length;
    // The fallback's window holds the prompt only without the old tool output.
    const est = Math.ceil(fullSize / 4);
    sinty.config.models.contextWindows = { "rec/big": 1_000_000, "small/tiny": est };
    sinty.config.models.fallback = ["small/tiny"];
    sinty.config.providers.rec = rec({ script, fail: true }) as SintyConfig["providers"][string];
    sinty.agent.send(s, "question 6: after the outage");
    await sinty.agent.idle();

    const events = sinty.journal.events(s);
    const fb = events.filter((e) => e.type === "model.fallback");
    assert.equal(fb.length, 1);
    assert.notEqual((fb[0]!.data as { reason: string }).reason, "window_too_small", "the primary's own error");
    const reqs = events.filter((e) => e.type === "model.request").slice(-2).map((e) => e.data as { model: string; trimmedForWindow?: boolean; messagesHash: string });
    assert.equal(reqs[0]!.model, "big");
    assert.equal(reqs[1]!.model, "tiny");
    assert.equal(reqs[1]!.trimmedForWindow, true);
    assert.notEqual(reqs[0]!.messagesHash, reqs[1]!.messagesHash);
    assert.ok(events.some((e) => e.type === "message.agent"), "the fallback answered");

    const sent = requests(home);
    const primary = sent.at(-2)!;
    const fallback = sent.at(-1)!;
    assert.equal(primary.model, "big");
    assert.equal(fallback.model, "tiny");
    assert.ok(JSON.stringify(primary.messages).includes("line 39: "), "the primary request keeps every tool line");
    assert.ok(JSON.stringify(fallback.messages).includes("older tool output truncated"));
    assert.ok(JSON.stringify(fallback.messages).length < JSON.stringify(primary.messages).length);
    // The stored history is unchanged: the next primary request carries the full tool output again.
    sinty.config.providers.rec = rec({ script }) as SintyConfig["providers"][string];
    sinty.agent.send(s, "question 7: primary is back");
    await sinty.agent.idle();
    const back = requests(home).at(-1)!;
    assert.equal(back.model, "big");
    assert.equal(back.messages.filter((m) => m.role === "tool").every((m) => !m.content.includes("older tool output truncated")), true);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("fallback window: a fallback too small even after trimming is skipped with model.fallback reason window_too_small", async () => {
  const { home, cleanup } = tempHome();
  const script = bigToolScript(4);
  const sinty = await boot(home, [], {
    config: recConfig({ rec: rec({ script }), small: rec({ script }), other: rec({ script }) }, {}),
    plugins: ["recording-provider", "test-tools"],
  });
  try {
    const s = sinty.agent.createSession().id;
    await talk(sinty, 4, s);
    sinty.config.models.contextWindows = { "rec/big": 1_000_000, "small/tiny": 2000, "other/wide": 500_000 };
    sinty.config.models.fallback = ["small/tiny", "other/wide"];
    sinty.config.providers.rec = rec({ script, fail: true }) as SintyConfig["providers"][string];
    sinty.agent.send(s, "question 4: after the outage");
    await sinty.agent.idle();

    const events = sinty.journal.events(s);
    const fb = events.filter((e) => e.type === "model.fallback").map((e) => e.data as { from: string; to: string; reason: string; window?: number; need?: number });
    assert.equal(fb.length, 2);
    assert.deepEqual([fb[0]!.from, fb[0]!.to], ["rec/big", "small/tiny"]);
    assert.deepEqual([fb[1]!.from, fb[1]!.to, fb[1]!.reason, fb[1]!.window], ["small/tiny", "other/wide", "window_too_small", 2000]);
    assert.ok(fb[1]!.need! > 2000);
    const models = events.filter((e) => e.type === "model.request").slice(-2).map((e) => (e.data as { model: string }).model);
    assert.deepEqual(models, ["big", "wide"], "the skipped route got no request");
    assert.ok(!requests(home).some((r) => r.model === "tiny"));
    assert.ok(events.some((e) => e.type === "turn.completed" && e.seq > events.findLast((x) => x.type === "message.user")!.seq));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("fallback window: the only fallback too small fails the turn with window_too_small", async () => {
  const { home, cleanup } = tempHome();
  const script = bigToolScript(3);
  const sinty = await boot(home, [], { config: recConfig({ rec: rec({ script }), small: rec({ script }) }, {}), plugins: ["recording-provider", "test-tools"] });
  try {
    const s = sinty.agent.createSession().id;
    await talk(sinty, 3, s);
    sinty.config.models.contextWindows = { "rec/big": 1_000_000, "small/tiny": 1500 };
    sinty.config.models.fallback = ["small/tiny"];
    sinty.config.providers.rec = rec({ script, fail: true }) as SintyConfig["providers"][string];
    sinty.agent.send(s, "question 3: after the outage");
    await sinty.agent.idle();
    const failed = sinty.journal.events(s).findLast((e) => e.type === "turn.failed");
    assert.match(JSON.stringify(failed?.data ?? {}), /window_too_small/);
  } finally {
    await sinty.stop();
    cleanup();
  }
});
