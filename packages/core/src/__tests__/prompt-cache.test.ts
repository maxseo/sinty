import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatMessage } from "@sinty/sdk";
import type { SintyConfig } from "../config.js";
import { policySchema } from "../config.js";
import { Sinty } from "../sinty.js";
import { boot, FIXTURES, tempHome } from "./helpers.js";

/**
 * Prompt caching (docs/spec/protocol.md, "Prompt caching"): providers reuse the longest unchanged prefix of a request.
 * These tests check the prefix the core builds stays byte-identical between model calls, turns and restarts.
 */

interface Step {
  text?: string;
  toolCalls?: { name: string; args: unknown }[];
}

interface Recorded {
  messages: ChatMessage[];
  tools: string[];
}

function recConfig(script: Record<string, Step[]>, extra: Partial<SintyConfig> = {}, options: Record<string, unknown> = {}): Partial<SintyConfig> {
  return {
    providers: { rec: { protocol: "rec", options: { script, ...options } } },
    models: { default: "rec/cache-model", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
    ...extra,
  };
}

function requests(home: string): Recorded[] {
  const file = join(home, "data", "recording-provider", "requests.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Recorded);
}

const isSummaryCall = (r: Recorded): boolean => r.messages.length === 1 && r.messages[0]!.content.includes("Reply with JSON only");

/** Wire form without the cache hints: hints only say where breakpoints go, they are not sent as content. */
const wire = (m: ChatMessage): string => {
  const { cacheHint: _hint, ...rest } = m;
  return JSON.stringify(rest);
};

/** Index of the first message of `next` that differs from `prev`, or -1 when `prev` is a prefix of `next`. */
function divergence(prev: ChatMessage[], next: ChatMessage[]): number {
  for (let i = 0; i < prev.length; i++) if (wire(prev[i]!) !== wire(next[i] ?? ({} as ChatMessage))) return i;
  return -1;
}

async function turn(sinty: Sinty, sessionId: string, text: string): Promise<void> {
  sinty.agent.send(sessionId, text);
  await sinty.agent.idle();
}

const SCRIPT: Record<string, Step[]> = {
  "remember the deploy": [
    {
      toolCalls: [
        { name: "memory__write", args: { text: "The user prefers short answers.", tier: "profile", scope: "user", about: "user" } },
        { name: "memory__write", args: { text: "Deploys go through staging first.", tier: "log", scope: "user", about: "work" } },
      ],
    },
    { text: "saved" },
  ],
  "how do deploys go": [{ toolCalls: [{ name: "memory__recall", args: { query: "deploys staging" } }] }, { text: "through staging" }],
  "and after a restart": [{ toolCalls: [{ name: "memory__recall", args: { query: "staging" } }] }, { text: "still staging" }],
};

test("prompt cache: each model call repeats the previous request and only appends, across steps, turns and a restart", async () => {
  const { home, cleanup } = tempHome();
  const config = recConfig(SCRIPT, { memory: { contextTokens: 128000, dimensions: 1536, recall: { auto: true } } as SintyConfig["memory"] });
  let sinty = await boot(home, [], { config, plugins: ["recording-provider"] });
  let sessionId = "";
  try {
    sessionId = sinty.agent.createSession().id;
    await turn(sinty, sessionId, "remember the deploy");
    await turn(sinty, sessionId, "how do deploys go");
  } finally {
    await sinty.stop();
  }
  sinty = await boot(home, [], { config, plugins: ["recording-provider"] });
  try {
    await turn(sinty, sessionId, "and after a restart");
    const all = requests(home).filter((r) => !isSummaryCall(r));
    assert.equal(all.length, 6, "two model calls per turn");
    for (let i = 1; i < all.length; i++) {
      assert.equal(divergence(all[i - 1]!.messages, all[i]!.messages), -1, `request ${i + 1} keeps request ${i} as its prefix`);
      assert.deepEqual(all[i]!.tools, all[0]!.tools, "the tool list does not change between calls");
    }
    assert.deepEqual(all[0]!.tools, [...all[0]!.tools].sort(), "tools are sorted by name");

    const first = all[0]!.messages;
    assert.equal(first[0]!.role, "system");
    assert.doesNotMatch(first[0]!.content, /Current time/, "the system prompt carries no clock");
    assert.equal(first[1]!.cacheHint, "static", "the skill catalog closes the static segment");
    assert.equal(first.filter((m) => m.role === "system").at(-1)!.cacheHint, "session", "the memory block closes the session segment");
    const contexts = all.at(-1)!.messages.filter((m) => m.role === "user" && m.content.startsWith("<turn_context>"));
    assert.equal(contexts.length, 3, "one frozen context block per turn");
    for (const c of contexts) assert.match(c.content, /Current time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}, \w+ \([^)]*UTC[+-]\d{2}:\d{2}\)/);
    assert.match(contexts[1]!.content, /staging/, "the second turn context carries recall");
    assert.match(contexts[1]!.content, /short answers/, "and the memory written during the first turn");
    assert.equal(all.at(-1)!.messages.at(-1)!.cacheHint, "turn", "the last dialogue message carries the turn hint");

    const events = sinty.journal.events(sessionId);
    assert.equal(events.filter((e) => e.type === "context.turn").length, 3, "the turn context is journaled once per turn");
    assert.equal(events.filter((e) => e.type === "memory.snapshot").length, 1, "the memory snapshot is taken once per session");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("prompt cache: compaction is stepped and the memory snapshot is refreshed only when it folds", async () => {
  const { home, cleanup } = tempHome();
  const summary = { summary: "The user asked many numbered questions.", facts: [] };
  const config = recConfig({}, { memory: { contextTokens: 6000, dimensions: 1536 } as SintyConfig["memory"] }, { summary });
  const sinty = await boot(home, [], { config, plugins: ["recording-provider"] });
  try {
    const s = sinty.agent.createSession();
    const turns = 40;
    for (let i = 0; i < turns; i++) await turn(sinty, s.id, `question ${i}: ${"padding ".repeat(30)}`);
    const all = requests(home);
    const folds = all.filter(isSummaryCall).length;
    assert.ok(folds >= 1, "the long session was compacted");
    assert.ok(folds <= turns / 6, `compaction does not run every turn (${folds} folds in ${turns} turns)`);
    const chat = all.filter((r) => !isSummaryCall(r));
    let breaks = 0;
    for (let i = 1; i < chat.length; i++) if (divergence(chat[i - 1]!.messages, chat[i]!.messages) !== -1) breaks++;
    assert.equal(breaks, folds, "the prefix only changes when the history is folded");
    const snapshots = sinty.journal.events(s.id).filter((e) => e.type === "memory.snapshot");
    assert.equal(snapshots.length, 1 + folds, "the memory snapshot is refreshed at each compaction");
    assert.deepEqual(
      snapshots.slice(1).map((e) => (e.data as { reason: string }).reason),
      Array(folds).fill("compaction"),
    );
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("prompt cache: a turn whose last 12 human turns alone pass the limit folds once, not on every step (ses_01M59Z72… turn D86D67)", async () => {
  // Repro of 2026-10-21: the kept 12 turns were over 65% of the window, so before every model step the same head was
  // folded again, the summary came back worded differently, its facts were stored again and the memory snapshot was
  // rebuilt: the prompt diverged at message 2 on every step and the provider cache read 0%.
  const { home, cleanup } = tempHome();
  const summary = { summary: "The user asked for riddles and jokes.", facts: [{ text: "The user likes riddles.", tier: "profile", about: "user" }] };
  const script: Record<string, Step[]> = {
    "find eyu2": [
      { toolCalls: [{ name: "memory__recall", args: { query: "eyu2" } }, { name: "memory__recall", args: { query: "scooter" } }] },
      { toolCalls: [{ name: "agent__task", args: { task: "look up eyu2", tools: ["memory.recall"] } }] },
      { text: "here is what I found" },
    ],
    "look up eyu2": [{ text: "child: nothing in memory" }],
  };
  const config = recConfig(script, { memory: { contextTokens: 6000, dimensions: 1536 } as SintyConfig["memory"] }, { summary, varySummary: true });
  const sinty = await boot(home, [], { config, plugins: ["recording-provider"], policy: policySchema.parse({ defaults: { none: "allow", read: "allow", write: "allow", external: "allow" } }) });
  try {
    const s = sinty.agent.createSession();
    // 14 human turns of ~1.6k chars: the last 12 alone (~4.8k tokens) are over the 3.9k limit.
    for (let i = 0; i < 14; i++) await turn(sinty, s.id, `question ${i}: ${"padding ".repeat(200)}`);
    const warmFolds = requests(home).filter(isSummaryCall).length;
    assert.ok(warmFolds >= 1 && warmFolds <= 4, `the long turns fold, but not on every turn (${warmFolds} folds in 14 turns)`);
    const before = requests(home).length;
    const seqBefore = sinty.journal.events(s.id).at(-1)!.seq;
    await turn(sinty, s.id, "find eyu2");
    const all = requests(home).slice(before);
    const steps = all.filter((r) => !isSummaryCall(r) && r.messages.some((m) => m.role === "user" && m.content === "find eyu2"));
    assert.equal(steps.length, 3, "three model steps in the turn");
    assert.ok(all.filter(isSummaryCall).length <= 1, `at most one fold in the turn (${all.filter(isSummaryCall).length})`);
    const after = sinty.journal.events(s.id).filter((e) => e.seq > seqBefore);
    assert.ok(after.filter((e) => e.type === "memory.compacted").length <= 1, "memory.compacted at most once in the turn");
    assert.ok(after.filter((e) => e.type === "memory.snapshot").length <= 1, "the memory snapshot is rebuilt at most once in the turn");
    assert.equal(divergence(steps[0]!.messages, steps[1]!.messages), -1, "step 2 repeats step 1 and only appends");
    assert.equal(divergence(steps[1]!.messages, steps[2]!.messages), -1, "step 3 repeats step 2 and only appends");
    // The next turn fits under the existing summary: no fold, the prefix holds across turns too.
    const n = requests(home).length;
    await turn(sinty, s.id, "thanks");
    const next = requests(home).slice(n);
    assert.equal(next.filter(isSummaryCall).length, 0, "no fold on the next turn");
    assert.equal(divergence(steps[2]!.messages, next[0]!.messages), -1, "the next turn keeps the prefix");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("prompt cache: a context plugin that rewrites earlier messages only gets to append", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { config: recConfig({}), plugins: ["recording-provider", "context-rewrite"] });
  try {
    const s = sinty.agent.createSession();
    await turn(sinty, s.id, "one");
    await turn(sinty, s.id, "two");
    const all = requests(home);
    for (const r of all) {
      assert.doesNotMatch(r.messages[0]!.content, /EDITED|context-rewrite/, "the system prompt stays as the core built it");
      assert.equal(r.messages.at(-1)!.content, "[context-rewrite] note at the end", "what the plugin appended is kept");
      assert.equal(r.messages.filter((m) => m.content.includes("note at the top")).length, 0, "the insertion is dropped");
    }
    const prev = all[0]!.messages.slice(0, -1);
    assert.equal(divergence(prev, all[1]!.messages), -1, "the prefix before the plugin's tail is reused by the next turn");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("prompt cache: plugins are kept in configured order so tool lists do not depend on start-up timing", async () => {
  const { home, cleanup } = tempHome();
  const enabled = ["test-tools", "recording-provider", "context-rewrite"];
  const order = async (): Promise<string[]> => {
    const sinty = await boot(home, [], { config: recConfig({}), plugins: enabled });
    try {
      return [...(sinty.host as unknown as { plugins: Map<string, unknown> }).plugins.keys()].filter((n) => enabled.includes(n));
    } finally {
      await sinty.stop();
    }
  };
  try {
    assert.deepEqual(await order(), enabled);
    assert.deepEqual(await order(), enabled, "and again after a restart");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Wire level: the bytes providers receive.

type Handler = (body: Record<string, unknown>, res: ServerResponse) => void;

async function serve(handler: Handler): Promise<{ server: Server; port: number; bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      bodies.push(raw);
      handler(JSON.parse(raw) as Record<string, unknown>, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as { port: number }).port, bodies };
}

async function wireSession(providers: SintyConfig["providers"], model: string, plugins: string[], texts: string[]): Promise<{ events: ReturnType<Sinty["journal"]["events"]> }> {
  const { home, cleanup } = tempHome();
  const sinty = new Sinty({
    home,
    config: {
      providers,
      models: { default: model, fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
      plugins: { enabled: plugins, config: {}, searchPaths: [FIXTURES] },
    },
    policy: policySchema.parse({ tools: { "echo.*": "allow" } }),
  });
  const { failedPlugins } = await sinty.start();
  try {
    assert.deepEqual(failedPlugins, []);
    const s = sinty.agent.createSession();
    for (const t of texts) await turn(sinty, s.id, t);
    return { events: sinty.journal.events(s.id) };
  } finally {
    await sinty.stop();
    cleanup();
  }
}

test("prompt cache: openai-compat requests keep a byte-identical prefix and DeepSeek cache hits are recorded", async () => {
  let n = 0;
  const { server, port, bodies } = await serve((body, res) => {
    n++;
    const messages = body.messages as { role: string }[];
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (d: unknown): boolean => res.write(`data: ${JSON.stringify(d)}\n\n`);
    if (messages.at(-1)!.role === "tool") send({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] });
    else send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${n}`, function: { name: "echo__say", arguments: '{"text":"ping"}' } }] }, finish_reason: "tool_calls" }] });
    send({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 } });
    res.end("data: [DONE]\n\n");
  });
  try {
    const { events } = await wireSession(
      { ds: { protocol: "openai-compat", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k" } },
      "ds/deepseek-chat",
      ["provider-openai-compat", "test-tools"],
      ["first", "second"],
    );
    assert.equal(bodies.length, 4);
    const parsed = bodies.map((b) => JSON.parse(b) as { messages: unknown[]; tools: unknown[]; prompt_cache_key?: string });
    for (let i = 1; i < parsed.length; i++) {
      const prev = parsed[i - 1]!.messages.map((m) => JSON.stringify(m));
      const next = parsed[i]!.messages.map((m) => JSON.stringify(m));
      assert.deepEqual(next.slice(0, prev.length), prev, `request ${i + 1} starts with request ${i} byte for byte`);
      assert.equal(JSON.stringify(parsed[i]!.tools), JSON.stringify(parsed[0]!.tools), "tools serialize identically");
    }
    assert.ok(!bodies.some((b) => b.includes("cacheHint")), "cache hints never reach the wire");
    assert.equal(parsed[0]!.prompt_cache_key, undefined, "no prompt_cache_key for third-party servers unless enabled");
    const usage = events.filter((e) => e.type === "usage.recorded").map((e) => e.data as Record<string, number>);
    assert.ok(usage.length >= 4);
    for (const u of usage.slice(0, 4)) {
      assert.equal(u.inputTokens, 1000);
      assert.equal(u.cachedTokens, 900);
      assert.equal(u.cacheMissTokens, 100);
    }
  } finally {
    server.close();
  }
});

test("prompt cache: anthropic gets cache_control breakpoints on the stable blocks and the turn tail", async () => {
  let n = 0;
  const { server, port, bodies } = await serve((body, res) => {
    n++;
    const messages = body.messages as { role: string; content: { type: string }[] }[];
    const last = messages.at(-1)!;
    const toolResult = last.content.some((b) => b.type === "tool_result");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, d: Record<string, unknown>): boolean => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
    send("message_start", { message: { usage: { input_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 150, output_tokens: 1 } } });
    if (toolResult) {
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
    } else {
      send("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${n}`, name: "echo__say", input: {} } });
      send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"text":"ping"}' } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } });
    }
    send("message_stop", {});
    res.end();
  });
  try {
    const { events } = await wireSession(
      { an: { protocol: "anthropic", baseUrl: `http://127.0.0.1:${port}`, apiKey: "k" } },
      "an/claude-test",
      ["provider-anthropic", "test-tools", "context-rewrite"],
      ["first", "second"],
    );
    assert.equal(bodies.length, 4);
    type Block = { type: string; text?: string; cache_control?: unknown };
    const parsed = bodies.map((b) => JSON.parse(b) as { system: Block[]; messages: { role: string; content: Block[] | string }[] });
    for (const body of parsed) {
      assert.ok(Array.isArray(body.system), "system is sent as blocks");
      assert.equal(body.system.filter((b) => b.cache_control).length, 2, "the end of the static and the session segment are breakpoints");
      assert.ok(body.system.at(-1)!.cache_control, "the last system block closes the session segment");
      assert.ok(!body.system.some((b) => b.text?.includes("context-rewrite")), "a tail system message is not merged into the system prompt");
      const blocks = body.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
      const marks = [...body.system, ...blocks].filter((b) => b.cache_control).length;
      assert.ok(marks >= 2 && marks <= 4, `between 2 and 4 breakpoints (${marks})`);
      const tail = blocks.at(-1)!;
      assert.match(tail.text ?? "", /<system>[\s\S]*note at the end/, "the plugin's tail note travels as user text");
    }
    // Flattened (role, block) sequence up to the previous request's turn breakpoint must repeat exactly.
    const flat = (b: (typeof parsed)[number]): { key: string; mark: boolean }[] =>
      b.messages.flatMap((m) =>
        (typeof m.content === "string" ? [{ type: "text", text: m.content } as Block] : m.content).map((blk) => {
          const { cache_control, ...rest } = blk;
          return { key: `${m.role}:${JSON.stringify(rest)}`, mark: cache_control !== undefined };
        }),
      );
    for (let i = 1; i < parsed.length; i++) {
      assert.equal(JSON.stringify(parsed[i]!.system.map(({ cache_control: _c, ...r }) => r)), JSON.stringify(parsed[0]!.system.map(({ cache_control: _c, ...r }) => r)));
      const prev = flat(parsed[i - 1]!);
      const cut = prev.findLastIndex((b) => b.mark);
      assert.ok(cut >= 0, "the previous request had a message breakpoint");
      assert.deepEqual(
        flat(parsed[i]!).slice(0, cut + 1).map((b) => b.key),
        prev.slice(0, cut + 1).map((b) => b.key),
        `request ${i + 1} repeats request ${i} up to its breakpoint`,
      );
    }
    const usage = events.filter((e) => e.type === "usage.recorded").map((e) => e.data as Record<string, number>);
    const u = usage[0]!;
    assert.equal(u.inputTokens, 1000);
    assert.equal(u.cachedTokens, 800);
    assert.equal(u.cacheWriteTokens, 150);
    assert.equal(u.cacheMissTokens, 200);
  } finally {
    server.close();
  }
});
