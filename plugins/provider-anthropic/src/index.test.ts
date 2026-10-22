import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage, ProviderRequest } from "@sinty/sdk";
import { buildBody, usageOf } from "./index.js";

const req = (messages: ChatMessage[], options?: Record<string, unknown>): ProviderRequest => ({
  endpoint: { baseUrl: "https://api.anthropic.com", ...(options ? { options } : {}) },
  model: "claude",
  messages,
  tools: [],
  signal: new AbortController().signal,
});

const LAYOUT: ChatMessage[] = [
  { role: "system", content: "rules" },
  { role: "system", content: "skills", cacheHint: "static" },
  { role: "system", content: "memory", cacheHint: "session" },
  { role: "user", content: "<turn_context>now</turn_context>" },
  { role: "user", content: "hi", cacheHint: "turn" },
  { role: "system", content: "tail note" },
];

test("anthropic: hinted blocks become cache_control breakpoints and a tail note stays out of system", () => {
  const body = buildBody(req(LAYOUT)) as { system: unknown[]; messages: { role: string; content: unknown[] }[] };
  assert.deepEqual(body.system, [
    { type: "text", text: "rules" },
    { type: "text", text: "skills", cache_control: { type: "ephemeral" } },
    { type: "text", text: "memory", cache_control: { type: "ephemeral" } },
  ]);
  assert.deepEqual(body.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "<turn_context>now</turn_context>" },
        { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
        { type: "text", text: "<system>\ntail note\n</system>" },
      ],
    },
  ]);
});

test("anthropic: promptCache false sends no breakpoints, cacheTtl 1h asks for the long cache, options stay Sinty's", () => {
  const off = buildBody(req(LAYOUT, { promptCache: false }));
  assert.ok(!JSON.stringify(off).includes("cache_control"));
  assert.ok(!("promptCache" in off));
  const long = buildBody(req(LAYOUT, { cacheTtl: "1h" }));
  assert.ok(JSON.stringify(long).includes('"ttl":"1h"'));
  assert.ok(!("cacheTtl" in long));
});

test("anthropic: at most 4 breakpoints and the turn tail always keeps one", () => {
  const many: ChatMessage[] = [
    ...["a", "b", "c", "d", "e"].map((t): ChatMessage => ({ role: "system", content: t, cacheHint: "session" })),
    { role: "user", content: "hi", cacheHint: "turn" },
  ];
  const text = JSON.stringify(buildBody(req(many)));
  assert.equal(text.split("cache_control").length - 1, 4);
  const body = buildBody(req(many)) as { messages: { content: { cache_control?: unknown }[] }[] };
  assert.ok(body.messages[0]!.content.at(-1)!.cache_control);
});

test("anthropic: input tokens add cache reads and writes; misses are what was not read", () => {
  assert.deepEqual(usageOf({ input_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 150 }, 3), {
    inputTokens: 1000,
    outputTokens: 3,
    cachedTokens: 800,
    cacheMissTokens: 200,
    cacheWriteTokens: 150,
  });
  assert.deepEqual(usageOf({ input_tokens: 40 }, 2), { inputTokens: 40, outputTokens: 2 });
});

test("anthropic: the Models API's max_input_tokens becomes contextWindow; null stays unknown", async () => {
  const { anthropicModels } = await import("./index.js");
  assert.deepEqual(
    anthropicModels({ data: [{ id: "claude-a", max_input_tokens: 200000, max_tokens: 64000 }, { id: "claude-b", max_input_tokens: null }, { nope: 1 }] }),
    [{ id: "claude-a", contextWindow: 200000, maxOutputTokens: 64000 }, { id: "claude-b" }],
  );
  assert.deepEqual(anthropicModels({}), []);
});
