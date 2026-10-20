import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SintyConfig } from "../config.js";
import { Sinty } from "../sinty.js";
import { boot, FIXTURES, tempHome, testConfig } from "./helpers.js";

type Step = { text?: string; toolCalls?: { name: string; args: unknown }[] };

function config(script: Record<string, Step[]>, pluginCfg: Record<string, unknown>, extra: Partial<SintyConfig> = {}): Partial<SintyConfig> {
  return {
    providers: { rec: { protocol: "rec", options: { script } } },
    models: { default: "rec/main", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
    plugins: { enabled: ["recording-provider", "memory-test"], config: { "memory-test": pluginCfg }, searchPaths: [FIXTURES] },
    ...extra,
  };
}

function lines(home: string, plugin: string, file: string): Record<string, unknown>[] {
  const p = join(home, "data", plugin, file);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
}

const twoSteps: Record<string, Step[]> = {
  "deploy plan": [{ toolCalls: [{ name: "memory__recall", args: { query: "deploy" } }] }, { text: "here is the plan" }],
};

test("router: a processor plan recalls once per turn, external records are untrusted and redacted", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { config: config(twoSteps, { plan: true, leak: "SUPERSECRET123" }), plugins: [] });
  sinty.secrets.set("vault.key", "SUPERSECRET123");
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "deploy plan");
    await sinty.agent.idle();
    const reqs = lines(home, "recording-provider", "requests.jsonl") as { messages: { role: string; content: string; untrusted?: boolean }[] }[];
    assert.equal(reqs.length, 2, "two model steps");
    for (const r of reqs) {
      const block = r.messages.find((m) => m.content.startsWith('<recalled_memory untrusted="true">'));
      assert.ok(block, "external block in every step");
      assert.equal(block.untrusted, true);
      assert.match(block.content, /\[memory-test\] notes\/a\.md: External note about deploy plan/);
      assert.doesNotMatch(block.content, /SUPERSECRET123/);
      assert.match(block.content, /\[redacted\]/);
      assert.equal(block.content.match(/<\/recalled_memory>/g)?.length, 1, "records cannot close the wrapper");
    }
    // one recall for the turn plan, one from the memory.recall tool call
    assert.equal(lines(home, "memory-test", "recall.jsonl").length, 2);
    const recalled = sinty.journal.events(s.id).filter((e) => e.type === "memory.recalled");
    assert.equal(recalled.length, 1);
    const tool = sinty.journal.events(s.id).find((e) => e.type === "tool.call.completed")?.data as { result: { provider?: string; untrusted?: boolean }[] };
    assert.ok(tool.result.some((r) => r.provider === "memory-test" && r.untrusted === true));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("router: a slow provider times out, is journaled as degraded and the turn still completes", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { config: config({}, { plan: true, slowMs: 1500 }, { memory: { contextTokens: 128000, dimensions: 1536, recall: { timeoutMs: 100 } } }), plugins: [] });
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "hello there");
    await sinty.agent.idle();
    const events = sinty.journal.events(s.id);
    const degraded = events.find((e) => e.type === "memory.degraded")?.data as { provider: string; reason: string };
    assert.equal(degraded.provider, "memory-test");
    assert.match(degraded.reason, /did not answer in 100 ms/);
    assert.ok(events.some((e) => e.type === "turn.completed"));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("router: onWrite can drop a write; afterTurn runs once per turn from the durable queue", async () => {
  const { home, cleanup } = tempHome();
  const script = { "remember it": [{ toolCalls: [{ name: "memory__write", args: { text: "DROP this secret plan", tier: "log", scope: "user", about: "user" } }] }, { text: "noted" }] };
  const sinty = await boot(home, [], { config: config(script, {}), plugins: [] });
  try {
    const s = sinty.agent.createSession();
    const { turnId } = sinty.agent.send(s.id, "remember it");
    await sinty.agent.idle();
    await sinty.memory.idle();
    const events = sinty.journal.events(s.id);
    const result = events.find((e) => e.type === "tool.call.completed")?.data as { result: { action: string; by: string } };
    assert.deepEqual(result.result, { id: "", action: "dropped", by: "memory-test" });
    const written = events.filter((e) => e.type === "memory.written").map((e) => e.data as { action: string; source: string });
    assert.deepEqual(written.map((w) => [w.action, w.source]), [["dropped", "agent"], ["inserted", "memory-test"]]);
    assert.deepEqual(lines(home, "memory-test", "after.jsonl"), [{ turnId }]);
    assert.deepEqual(sinty.memory.jobs().map((j) => [j.turnId, j.status]), [[turnId, "done"]]);
    // replaying the same turn is a no-op
    sinty.memory.afterTurn({ turn: { sessionId: s.id, turnId, agentId: "Sinty", userId: "local", text: "remember it" }, reply: "noted", messages: [] });
    await sinty.memory.idle();
    assert.equal(lines(home, "memory-test", "after.jsonl").length, 1);
    assert.match(sinty.memory.builtin.block({ agentId: "Sinty", chatId: s.id }), /The agent replied: noted/);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("router: a failing afterTurn is retried and given up after 3 attempts with memory.degraded", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { config: config({}, { failAfterTurn: true }), plugins: [] });
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "hi");
    await sinty.agent.idle();
    for (let i = 0; i < 3; i++) {
      sinty.memory.kick();
      await sinty.memory.idle();
    }
    assert.equal(sinty.memory.jobs()[0]?.status, "failed");
    assert.equal(sinty.memory.jobs()[0]?.attempts, 3);
    assert.ok(sinty.journal.events(s.id).some((e) => e.type === "memory.degraded" && (e.data as { hook: string }).hook === "afterTurn"));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("router: when the summary call fails the prompt is trimmed to the last 12 user turns", async () => {
  const { home, cleanup } = tempHome();
  const cfg = config({}, {}, { memory: { contextTokens: 1500, dimensions: 1536 }, service: { model: "missing/model", compress: "", facts: "" } });
  cfg.plugins = { enabled: ["recording-provider"], config: {}, searchPaths: [FIXTURES] };
  const sinty = await boot(home, [], { config: cfg, plugins: [] });
  try {
    const s = sinty.agent.createSession();
    for (let i = 0; i < 16; i++) {
      sinty.agent.send(s.id, `question ${i}: ${"padding ".repeat(30)}`);
      await sinty.agent.idle();
    }
    const reqs = lines(home, "recording-provider", "requests.jsonl") as { messages: { role: string }[] }[];
    const users = reqs.at(-1)!.messages.filter((m) => m.role === "user").length;
    assert.equal(users, 12);
    const events = sinty.journal.events(s.id);
    assert.ok(events.some((e) => e.type === "memory.compacted" && (e.data as { ok: boolean }).ok === false));
    assert.ok(events.some((e) => e.type === "memory.degraded"));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("router: stop() drains the afterTurn queue before plugins stop (sinty run exits right after the turn)", async () => {
  const { home, cleanup } = tempHome();
  const script = { "remember it": [{ text: "noted" }] };
  const sinty = await boot(home, [], { config: config(script, { afterTurnSlowMs: 300 }), plugins: [] });
  let turnId = "";
  try {
    const s = sinty.agent.createSession();
    turnId = sinty.agent.send(s.id, "remember it").turnId;
    await sinty.agent.idle();
    // no memory.idle(): exactly what `sinty run` does
  } finally {
    await sinty.stop();
  }
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(home, "data", "memory", "memory.db"), { readOnly: true });
    const jobs = db.prepare("SELECT turn_id, status FROM memory_jobs").all() as { turn_id: string; status: string }[];
    const facts = db.prepare("SELECT text, source FROM memory_facts").all() as { text: string; source: string }[];
    db.close();
    assert.deepEqual(jobs.map((j) => [j.turn_id, j.status]), [[turnId, "done"]]);
    assert.deepEqual(facts.map((f) => [f.text, f.source]), [["The agent replied: noted", "memory-test"]]);
  } finally {
    cleanup();
  }
});

test("router: stop() gives up waiting after the close timeout; the job stays pending and runs on the next start", async () => {
  const { home, cleanup } = tempHome();
  const script = { "remember it": [{ text: "noted" }] };
  const warnings: string[] = [];
  const sinty = new Sinty({
    home,
    config: testConfig([], config(script, { afterTurnSlowMs: 5000 }), []),
    log: (level, msg) => {
      if (level === "warn") warnings.push(msg);
    },
  });
  await sinty.start();
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "remember it");
    await sinty.agent.idle();
    const t0 = Date.now();
    await sinty.stop({ drainTimeoutMs: 200 });
    assert.ok(Date.now() - t0 < 3000, "shutdown is not held by the slow job");
    assert.ok(warnings.some((w) => /1 afterTurn job\(s\) still pending at shutdown after waiting 200 ms/.test(w)), warnings.join("\n"));
    assert.ok(!warnings.some((w) => /memory is closed/.test(w)));
    // next start picks the job up
    const again = await boot(home, [], { config: config(script, {}), plugins: [] });
    try {
      await again.memory.idle();
      assert.deepEqual(again.memory.jobs().map((j) => j.status), ["done"]);
    } finally {
      await again.stop();
    }
  } finally {
    cleanup();
  }
});

test("router: memory.write through the tool journals memory.written once per write", async () => {
  const { home, cleanup } = tempHome();
  const write = { name: "memory__write", args: { text: "Max deploys on Fridays.", tier: "log", scope: "agent", about: "work" } };
  const script = { "remember": [{ toolCalls: [write] }, { text: "ok" }], "again": [{ toolCalls: [write] }, { text: "ok" }] };
  const sinty = await boot(home, [], { config: { ...config(script, {}), plugins: { enabled: ["recording-provider"], config: {}, searchPaths: [FIXTURES] } }, plugins: [] });
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "remember");
    await sinty.agent.idle();
    sinty.agent.send(s.id, "again");
    await sinty.agent.idle();
    const written = sinty.journal.events(s.id).filter((e) => e.type === "memory.written").map((e) => e.data as { id: string; action: string; tier: string; scope: string; source: string; provider: string });
    assert.equal(written.length, 2, "one event per tool write, no duplicates");
    assert.deepEqual(written.map((w) => [w.action, w.tier, w.scope, w.source, w.provider]), [
      ["inserted", "log", "agent", "agent", "builtin:sqlite"],
      ["updated", "log", "agent", "agent", "builtin:sqlite"],
    ]);
    assert.equal(written[0]!.id, written[1]!.id);
    const tool = sinty.journal.events(s.id).find((e) => e.type === "tool.call.completed")?.data as { result: { id: string } };
    assert.equal(tool.result.id, written[0]!.id);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("router: reindexVectors embeds facts that have no vector, in batches, idempotently", async () => {
  const { home, cleanup } = tempHome();
  const w = (text: string) => ({ name: "memory__write", args: { text, tier: "log", scope: "user", about: "work" } });
  const script = {
    seed: [{ toolCalls: [w("abab abab baba"), w("cdcd dcdc cdcd"), w("abab cdcd")] }, { text: "ok" }],
    find: [{ toolCalls: [{ name: "memory__recall", args: { query: "efef fefe" } }] }, { text: "ok" }],
  };
  const plugins = { enabled: ["recording-provider"], config: {}, searchPaths: [FIXTURES] };
  const base = { providers: { rec: { protocol: "rec", options: { script, dims: 4 } } }, plugins, memory: { contextTokens: 128000, dimensions: 4 } };
  const noEmbed = { ...base, models: { default: "rec/main", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 } };
  const withEmbed = { ...base, models: { default: "rec/main", fallback: [], routes: { embed: "rec/emb" }, catalog: [], maxOutputTokens: 1000 } };
  const embedCalls = (): number => lines(home, "recording-provider", "requests.jsonl").filter((r) => "embed" in r).length;
  try {
    const first = await boot(home, [], { config: noEmbed, plugins: [] });
    try {
      const s = first.agent.createSession();
      first.agent.send(s.id, "seed");
      await first.agent.idle();
      assert.equal(first.memory.builtin.store.countMissingVectors(), 3, "written without an embed route");
      await assert.rejects(() => first.memory.reindexVectors(), /models.routes.embed is not set/);
    } finally {
      await first.stop();
    }
    const second = await boot(home, [], { config: withEmbed, plugins: [] });
    try {
      assert.deepEqual(await second.memory.reindexVectors({ dryRun: true }), { total: 3, embedded: 0, dryRun: true });
      assert.equal(embedCalls(), 0, "dry run calls no model");
      const progress: string[] = [];
      const r = await second.memory.reindexVectors({ batchSize: 2, onProgress: (p) => progress.push(`${p.done}/${p.total}`) });
      assert.deepEqual(r, { total: 3, embedded: 3, dryRun: false });
      assert.deepEqual(progress, ["2/3", "3/3"]);
      assert.equal(embedCalls(), 2, "two batches");
      assert.equal(second.memory.builtin.store.countMissingVectors(), 0);
      assert.deepEqual(await second.memory.reindexVectors(), { total: 0, embedded: 0, dryRun: false }, "rerun is a no-op");
      assert.equal(embedCalls(), 2);
      // the backfilled vectors are used: no word overlap, found by vector
      const s = second.agent.createSession();
      second.agent.send(s.id, "find");
      await second.agent.idle();
      const found = second.journal.events(s.id).filter((e) => e.type === "tool.call.completed").map((e) => (e.data as { result: { text: string }[] }).result).at(-1)!;
      assert.ok(found.length >= 1);
      assert.equal(found[0]!.text, "abab abab baba");
    } finally {
      await second.stop();
    }
  } finally {
    cleanup();
  }
});
