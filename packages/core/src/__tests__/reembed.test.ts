import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { SintyConfig } from "../config.js";
import { MemoryStore } from "../memory.js";
import { boot, FIXTURES, tempHome } from "./helpers.js";

/** Re-embedding after an embedding model or width change (docs/journal/2026-10-22-reembed.md). */

const v = (...xs: number[]) => new Float32Array(xs);

function dbFile(): string {
  return join(mkdtempSync(join(tmpdir(), "sinty-reembed-")), "memory.db");
}

test("reembed: vectors remember their model; another model's vectors are skipped by search and listed as stale", () => {
  const file = dbFile();
  let model = "rec/emb-a";
  const store = new MemoryStore(file, { userId: "local", agentId: "Sinty", dimensions: 4, embedModel: () => model });
  const a = store.write({ text: "zzz one", tier: "log", scope: "user", about: "work", source: "chat", embedding: v(1, 0, 0, 0) });
  const b = store.write({ text: "zzz two", tier: "log", scope: "user", about: "work", source: "chat", embedding: v(0, 1, 0, 0) });
  const query = (e: Float32Array) => store.recall({ query: "qqq", chatId: "", embedding: e }).map((f) => f.id);
  assert.deepEqual(query(v(1, 0, 0, 0))[0], a.id, "same model: vector hit");
  assert.deepEqual(store.vectorStatus(), { vec: true, width: 4, dimensions: 4, widthMismatch: false, model: "rec/emb-a", facts: 2, current: 2, stale: 0, missing: 0 });

  model = "rec/emb-b";
  assert.deepEqual(query(v(1, 0, 0, 0)), [], "a query of the new model is not compared with the old model's vectors");
  assert.equal(store.vectorStatus().stale, 2);
  assert.equal(store.countMissingVectors(), 2, "stale vectors need a new one");
  assert.deepEqual(store.missingVectors(10).map((r) => r.id).sort(), [a.id, b.id].sort());
  store.setVector(b.id, v(0, 0, 1, 0));
  assert.deepEqual(query(v(0, 0, 1, 0)), [b.id], "only the re-embedded fact is found by vector");
  assert.deepEqual(store.vectorStatus(), { vec: true, width: 4, dimensions: 4, widthMismatch: false, model: "rec/emb-b", facts: 2, current: 1, stale: 1, missing: 0 });
  store.forget({ id: a.id });
  assert.equal(store.vectorStatus().stale, 0, "forgetting a fact drops its vector metadata");
  store.close();
});

test("reembed: vectors from before the metadata table are credited to the embed route once", () => {
  const file = dbFile();
  const old = new MemoryStore(file, { userId: "local", agentId: "Sinty", dimensions: 4 });
  const a = old.write({ text: "zzz legacy", tier: "log", scope: "user", about: "work", source: "chat", embedding: v(1, 0, 0, 0) });
  old.close();
  // What an older core left behind: vectors and no metadata.
  const raw = new DatabaseSync(file);
  raw.exec("DROP TABLE facts_vec_meta");
  raw.close();
  let model = "openai/text-embedding-3-small";
  const store = new MemoryStore(file, { userId: "local", agentId: "Sinty", dimensions: 4, embedModel: () => model });
  assert.equal(store.vectorStatus().current, 1, "adopted by the configured route");
  assert.deepEqual(store.recall({ query: "qqq", chatId: "", embedding: v(1, 0, 0, 0) }).map((f) => f.id), [a.id]);
  store.close();
  model = "openai/text-embedding-3-large";
  const later = new MemoryStore(file, { userId: "local", agentId: "Sinty", dimensions: 4, embedModel: () => model });
  assert.equal(later.vectorStatus().stale, 1, "adoption happens once: a later route change makes them stale");
  later.close();
});

test("reembed: facts_vec of another width than memory.dimensions turns vectors off instead of failing writes", () => {
  const file = dbFile();
  const four = new MemoryStore(file, { userId: "local", agentId: "Sinty", dimensions: 4, embedModel: () => "rec/emb" });
  four.write({ text: "zzz alpha", tier: "log", scope: "user", about: "work", source: "chat", embedding: v(1, 0, 0, 0) });
  four.close();
  const eight = new MemoryStore(file, { userId: "local", agentId: "Sinty", dimensions: 8, embedModel: () => "rec/emb" });
  assert.equal(eight.vecReady, false);
  assert.equal(eight.vectorStatus().widthMismatch, true);
  // Old code: INSERT into a float[4] table with an 8-wide vector threw, so the write failed.
  const b = eight.write({ text: "zzz beta", tier: "log", scope: "user", about: "work", source: "chat", embedding: new Float32Array(8).fill(0.5) });
  assert.equal(b.action, "inserted");
  assert.deepEqual(eight.recall({ query: "beta", chatId: "", embedding: new Float32Array(8).fill(0.5) }).map((f) => f.id), [b.id], "full-text search still works");
  assert.equal(eight.countMissingVectors(), 0, "nothing can be stored until the table is rebuilt");
  eight.rebuildVectors();
  assert.equal(eight.vecReady, true);
  assert.equal(eight.countMissingVectors(), 2, "after the rebuild every fact needs a vector");
  eight.close();
});

type Step = { text?: string; toolCalls?: { name: string; args: unknown }[] };

function lines(home: string, plugin: string, file: string): Record<string, unknown>[] {
  const p = join(home, "data", plugin, file);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
}

function cfg(embed: string, dims: number, extra: Partial<SintyConfig["memory"]> = {}): Partial<SintyConfig> {
  const w = (text: string) => ({ name: "memory__write", args: { text, tier: "log", scope: "user", about: "work" } });
  const script: Record<string, Step[]> = {
    seed: [{ toolCalls: [w("abab abab baba"), w("cdcd dcdc cdcd"), w("abab cdcd")] }, { text: "ok" }],
    find: [{ toolCalls: [{ name: "memory__recall", args: { query: "efef fefe" } }] }, { text: "ok" }],
  };
  return {
    providers: { rec: { protocol: "rec", options: { script, dims } } },
    models: { default: "rec/main", fallback: [], routes: { embed }, catalog: [], maxOutputTokens: 1000 },
    plugins: { enabled: ["recording-provider"], config: {}, searchPaths: [FIXTURES] },
    memory: { contextTokens: 128000, dimensions: dims, ...extra } as SintyConfig["memory"],
  };
}

test("reembed: after models.routes.embed changes, recall journals the stale vectors once and reindexVectors replaces them", async () => {
  const { home, cleanup } = tempHome();
  const embeds = () => lines(home, "recording-provider", "requests.jsonl").filter((r) => "embed" in r) as { embed: string; input: string[] }[];
  try {
    const first = await boot(home, [], { config: cfg("rec/emb-a", 4), plugins: [] });
    try {
      first.agent.send(first.agent.createSession().id, "seed");
      await first.agent.idle();
      assert.equal(first.memory.builtin.store.vectorStatus().current, 3);
    } finally {
      await first.stop();
    }
    const second = await boot(home, [], { config: cfg("rec/emb-b", 4), plugins: [] });
    try {
      const s = second.agent.createSession();
      second.agent.send(s.id, "find");
      await second.agent.idle();
      const degraded = second.journal.events(s.id).filter((e) => e.type === "memory.degraded").map((e) => (e.data as { reason: string }).reason);
      assert.equal(degraded.length, 1);
      assert.match(degraded[0]!, /3 fact\(s\) have vectors of another embedding model than rec\/emb-b.*sinty memory reembed/);
      assert.deepEqual(await second.memory.reindexVectors({ dryRun: true }), { total: 3, embedded: 0, dryRun: true, stale: 3, rebuilt: false });
      const before = embeds().length;
      assert.deepEqual(await second.memory.reindexVectors(), { total: 3, embedded: 3, dryRun: false, stale: 3, rebuilt: false });
      assert.ok(embeds().slice(before).every((r) => r.embed === "emb-b"), "re-embedded with the new model");
      assert.equal(second.memory.builtin.store.vectorStatus().current, 3);
      assert.equal((await second.memory.reindexVectors()).total, 0, "idempotent");
    } finally {
      await second.stop();
    }
  } finally {
    cleanup();
  }
});

test("reembed: a new memory.dimensions rebuilds facts_vec; memory.reembed: auto does it on start in the background", async () => {
  const { home, cleanup } = tempHome();
  try {
    const first = await boot(home, [], { config: cfg("rec/emb", 4), plugins: [] });
    try {
      first.agent.send(first.agent.createSession().id, "seed");
      await first.agent.idle();
    } finally {
      await first.stop();
    }
    const second = await boot(home, [], { config: cfg("rec/emb", 8, { reembed: "auto" }), plugins: [] });
    try {
      for (let i = 0; i < 100 && second.memory.builtin.store.vectorStatus().current < 3; i++) await new Promise((r) => setTimeout(r, 50));
      const st = second.memory.builtin.store.vectorStatus();
      assert.deepEqual({ width: st.width, widthMismatch: st.widthMismatch, current: st.current, missing: st.missing }, { width: 8, widthMismatch: false, current: 3, missing: 0 });
      const s = second.agent.createSession();
      second.agent.send(s.id, "find");
      await second.agent.idle();
      const found = second.journal.events(s.id).filter((e) => e.type === "tool.call.completed").map((e) => (e.data as { result: { text: string }[] }).result).at(-1)!;
      assert.ok(found.length >= 1, "the rebuilt vectors are searched");
    } finally {
      await second.stop();
    }
  } finally {
    cleanup();
  }
});
