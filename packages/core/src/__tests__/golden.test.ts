import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SintyConfig } from "../config.js";
import { boot, tempHome } from "./helpers.js";

/**
 * Golden prompts: what the model receives must not change when memory internals are refactored.
 * Snapshots live in src/__tests__/golden. Regenerate on purpose with UPDATE_GOLDEN=1 and explain the diff in docs/journal.
 */
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "__tests__", "golden");

interface Step {
  text?: string;
  toolCalls?: { name: string; args: unknown }[];
}

function recConfig(script: Record<string, Step[]>, extra: Partial<SintyConfig> = {}, options: Record<string, unknown> = {}): Partial<SintyConfig> {
  return {
    providers: { rec: { protocol: "rec", options: { script, ...options } } },
    models: { default: "rec/golden-model", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
    ...extra,
  };
}

function requests(home: string): unknown[] {
  const file = join(home, "data", "recording-provider", "requests.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);
}

function normalize(value: unknown, home: string): unknown {
  const text = JSON.stringify(value, null, 2)
    .split(home.replaceAll("\\", "\\\\"))
    .join("<HOME>")
    .split(home)
    .join("<HOME>")
    // Windows: paths under the temp home use backslashes; snapshots use "/".
    .replace(/<HOME>(?:\\\\[\w.-]+)+/g, (m) => m.replaceAll("\\\\", "/"))
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<TIME>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>")
    .replace(/(ses|trn|stp|call|evt|inc)_[0-9A-Za-z]{10,}/g, "$1_<ID>");
  return JSON.parse(text) as unknown;
}

function golden(name: string, actual: unknown): void {
  const file = join(GOLDEN, `${name}.json`);
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
    if (process.env.UPDATE_GOLDEN !== "1") throw new Error(`golden ${name} was missing and has been written; rerun the tests`);
    return;
  }
  assert.deepEqual(actual, JSON.parse(readFileSync(file, "utf8")), `golden prompt ${name} changed`);
}

async function turn(sinty: Awaited<ReturnType<typeof boot>>, sessionId: string, text: string): Promise<void> {
  sinty.agent.send(sessionId, text);
  await sinty.agent.idle();
}

const SEED: Record<string, Step[]> = {
  seed: [
    {
      toolCalls: [
        { name: "memory__write", args: { text: "The user prefers short answers.", tier: "profile", scope: "user", about: "user" } },
        { name: "memory__write", args: { text: "Deployed the site on Friday.", tier: "log", scope: "user", about: "work" } },
        { name: "memory__write", args: { text: "Draft lives in notes/plan.md.", tier: "note", scope: "user", about: "work" } },
      ],
    },
    { text: "saved" },
  ],
  "what do you know": [{ toolCalls: [{ name: "memory__recall", args: { query: "draft plan" } }] }, { text: "found it" }],
  "forget it": [{ toolCalls: [{ name: "memory__forget", args: { text: "Draft lives in notes/plan.md." } }] }, { text: "forgotten" }],
};

test("golden: memory block, memory tools and recall reach the model unchanged", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { config: recConfig(SEED), plugins: ["recording-provider"] });
  try {
    const a = sinty.agent.createSession();
    await turn(sinty, a.id, "seed");
    const b = sinty.agent.createSession();
    await turn(sinty, b.id, "hello");
    await turn(sinty, b.id, "what do you know");
    await turn(sinty, b.id, "forget it");
    golden("memory-tools", normalize(requests(home), home));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("golden: compaction folds old turns into a summary and stores its facts", async () => {
  const { home, cleanup } = tempHome();
  const summary = { summary: "The user asked fourteen numbered questions.", facts: [{ text: "The user counts questions.", tier: "log", about: "user" }] };
  const config = recConfig({}, { memory: { contextTokens: 1500, dimensions: 1536 } }, { summary });
  const sinty = await boot(home, [], { config, plugins: ["recording-provider"] });
  try {
    const s = sinty.agent.createSession();
    for (let i = 0; i < 16; i++) await turn(sinty, s.id, `question ${i}: ${"padding ".repeat(30)}`);
    const all = requests(home) as { messages: { content: string }[] }[];
    const summaryCalls = all.filter((r) => r.messages.length === 1 && r.messages[0]!.content.includes("Reply with JSON only"));
    assert.ok(summaryCalls.length >= 1, "a summary call was made");
    const written = sinty.journal.events(s.id).filter((e) => e.type === "memory.written");
    assert.ok(written.length >= 1, "summary facts are journaled");
    assert.equal((written[0]!.data as { source: string }).source, "summary");
    golden("compaction", normalize({ firstSummaryCall: summaryCalls[0], lastRequest: all.at(-1), summaryCalls: summaryCalls.length, requests: all.length }, home));
  } finally {
    await sinty.stop();
    cleanup();
  }
});
