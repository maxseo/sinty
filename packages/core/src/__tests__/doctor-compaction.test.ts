import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { configSchema } from "../config.js";
import { describeCompaction } from "../index.js";

/** `sinty doctor` reports the compaction point the memory router uses (docs/journal/2026-10-22-doctor-compaction-cap.md). */

const cfg = (memory: Record<string, unknown>) => configSchema.parse({ memory });
const big = { tokens: 1_048_576, source: "provider" as const, route: "deepseek/deepseek-v4-pro" };

test("doctor compaction line: the default cap applies to a 1M window", () => {
  assert.equal(
    describeCompaction("deepseek/deepseek-v4-pro", big, cfg({})),
    "context window deepseek/deepseek-v4-pro: 1048576 tokens (provider), summary at 150000 (memory.compactCapTokens; 65% of the window would be 681574)",
  );
  assert.match(describeCompaction("x/y", big, cfg({ compactCapTokens: 200000 })), /summary at 200000 \(memory\.compactCapTokens;/);
});

test("doctor compaction line: 65% of the window when it is lower than the cap, or with the cap off", () => {
  const small = { tokens: 128_000, source: "fallback" as const, route: "local/x" };
  assert.equal(
    describeCompaction("local/x", small, cfg({})),
    "context window local/x: 128000 tokens (fallback: unknown model, set models.contextWindows or memory.contextTokens), summary at 83200 (65% of the window; memory.compactCapTokens 150000 is higher)",
  );
  for (const off of [0, null]) assert.match(describeCompaction("x/y", big, cfg({ compactCapTokens: off })), /summary at 681574 \(65% of the window; no memory\.compactCapTokens cap\)$/);
});

test("doctor compaction line: sinty doctor prints describeCompaction, not its own 65% math", () => {
  const bin = readFileSync(join(import.meta.dirname, "..", "..", "..", "cli", "src", "bin.ts"), "utf8");
  const doctor = bin.slice(bin.indexOf("async function doctor("), bin.indexOf("\n}\n", bin.indexOf("async function doctor(")));
  assert.match(doctor, /describeCompaction\(def, w, sinty\.config\)/);
  assert.doesNotMatch(doctor, /0\.65|summary at \$\{/, "the doctor must not compute the point itself");
});
