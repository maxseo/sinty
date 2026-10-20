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
