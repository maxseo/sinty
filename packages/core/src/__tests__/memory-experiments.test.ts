import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SintyConfig } from "../config.js";
import { evalMemory } from "../memory-eval.js";
import { assignArms } from "../memory-router.js";
import { Sinty } from "../sinty.js";
import { boot, FIXTURES, tempHome } from "./helpers.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "cli", "dist", "bin.js");

test("experiments: arms are stable per session and follow the weights", () => {
  const xs = [{ name: "recall", arms: [{ name: "a", weight: 1 }, { name: "b", weight: 3 }], shadow: [] }];
  assert.deepEqual(assignArms(xs, "ses_1"), assignArms(xs, "ses_1"));
  let b = 0;
  for (let i = 0; i < 2000; i++) if (assignArms(xs, `ses_${i}`)[0]!.arm === "b") b++;
  assert.ok(b > 1350 && b < 1650, `about 75% in arm b, got ${b}`);
  const zero = [{ name: "z", arms: [{ name: "on", weight: 1 }, { name: "never", weight: 0 }], shadow: ["never"] }];
  for (let i = 0; i < 50; i++) assert.equal(assignArms(zero, `s${i}`)[0]!.arm, "on");
  assert.deepEqual(assignArms(zero, "s")[0]!.shadow.map((s) => s.arm), ["never"]);
});

test("experiments: the arm's overrides apply, the arm is journaled, shadow arms are journaled but not shown", async () => {
  const { home, cleanup } = tempHome();
  const experiments = [{ name: "auto", arms: [{ name: "on", weight: 1, recall: { auto: true } }, { name: "tight", weight: 0, recall: { auto: true, limit: 1 } }], shadow: ["tight"] }];
  const config: Partial<SintyConfig> = {
    providers: { rec: { protocol: "rec", options: { script: {} } } },
    models: { default: "rec/main", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
    plugins: { enabled: ["recording-provider"], config: {}, searchPaths: [FIXTURES] },
    memory: { contextTokens: 128000, dimensions: 1536, experiments },
  };
  const sinty = await boot(home, [], { config, plugins: [] });
  try {
    sinty.memory.builtin.write({ text: "The staging deploy runs on Fridays.", tier: "note", scope: "user", about: "work", source: "test", agentId: "Sinty" });
    sinty.memory.builtin.write({ text: "Staging uses the blue database.", tier: "note", scope: "user", about: "work", source: "test", agentId: "Sinty" });
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "staging");
    await sinty.agent.idle();
    const events = sinty.journal.events(s.id);
    assert.deepEqual(events.find((e) => e.type === "memory.experiment")?.data, { experiment: "auto", arm: "on", shadow: ["tight"] });
    const recalled = events.filter((e) => e.type === "memory.recalled").map((e) => e.data as { arm?: string; shadow?: boolean; records: unknown[] });
    assert.equal(recalled.length, 2);
    assert.deepEqual([recalled[0]!.arm, recalled[0]!.shadow, recalled[0]!.records.length], ["auto=on", undefined, 2]);
    assert.deepEqual([recalled[1]!.arm, recalled[1]!.shadow, recalled[1]!.records.length], ["auto=tight", true, 1]);
    const prompt = readFileSync(join(home, "data", "recording-provider", "requests.jsonl"), "utf8");
    assert.equal((prompt.match(/<recalled_memory>/g) ?? []).length, 1, "only the live arm reaches the prompt");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("memory eval: hit rate on labeled queries, tokens and latency per arm, nothing journaled", async () => {
  const { home, cleanup } = tempHome();
  const experiments = [{ name: "limit", arms: [{ name: "one", weight: 1, recall: { limit: 1 } }], shadow: [] }];
  const sinty = new Sinty({ home, config: { plugins: { enabled: [], config: {}, searchPaths: [] }, memory: { contextTokens: 128000, dimensions: 1536, experiments } } });
  try {
    await sinty.start({ background: false });
    sinty.memory.builtin.write({ text: "Deploys go through staging first.", tier: "log", scope: "user", about: "work", source: "t", agentId: "Sinty" });
    sinty.memory.builtin.write({ text: "Staging database is blue.", tier: "log", scope: "user", about: "work", source: "t", agentId: "Sinty" });
    const labels = [
      { query: "staging", expect: ["deploys go through"] },
      { query: "pancakes", expect: ["flour"] },
    ];
    const reports = await evalMemory(sinty, { labels });
    assert.deepEqual(reports.map((r) => r.arm), ["baseline", "limit=one"]);
    assert.equal(reports[0]!.hitRate, 0.5);
    assert.equal(reports[0]!.meanRecords, 1);
    assert.ok(reports[0]!.meanMemoryTokens > reports[0]!.meanRecalledTokens);
    assert.equal(reports[1]!.meanRecords, 0.5);
    assert.equal(sinty.journal.listSessions().length, 0);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("sinty memory eval: the CLI prints a report", { skip: existsSync(CLI) ? false : "build packages/cli first" }, () => {
  const { home, cleanup } = tempHome();
  try {
    writeFileSync(join(home, "config.yaml"), "plugins:\n  enabled: []\n");
    const labels = join(home, "labels.jsonl");
    writeFileSync(labels, `${JSON.stringify({ query: "anything", expect: ["x"] })}\n`);
    const out = execFileSync(process.execPath, [CLI, "memory", "eval", "--home", home, "--labels", labels, "--json"], { encoding: "utf8" });
    const reports = JSON.parse(out) as { arm: string; hitRate: number }[];
    assert.equal(reports[0]!.arm, "baseline");
    assert.equal(reports[0]!.hitRate, 0);
  } finally {
    cleanup();
  }
});
