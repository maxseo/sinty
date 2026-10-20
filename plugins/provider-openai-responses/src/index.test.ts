import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderRequest } from "@sinty/sdk";
import { buildBody, usageOf } from "./index.js";

const req = (options?: Record<string, unknown>): ProviderRequest => ({
  endpoint: { baseUrl: "https://api.openai.com/v1", ...(options ? { options } : {}) },
  model: "m",
  messages: [
    { role: "system", content: "rules", cacheHint: "static" },
    { role: "system", content: "memory", cacheHint: "session" },
    { role: "user", content: "hi", cacheHint: "turn" },
    { role: "system", content: "tail note" },
  ],
  tools: [],
  cacheKey: "sinty-abc",
  signal: new AbortController().signal,
});

test("openai-responses: only leading system messages become instructions; a tail note stays in place", () => {
  const body = buildBody(req());
  assert.equal(body.instructions, "rules\n\nmemory");
  assert.deepEqual(body.input, [
    { role: "user", content: "hi" },
    { role: "developer", content: "tail note" },
  ]);
});

test("openai-responses: prompt_cache_key is the session cache key unless turned off", () => {
  assert.equal(buildBody(req()).prompt_cache_key, "sinty-abc");
  const off = buildBody(req({ promptCacheKey: false }));
  assert.equal(off.prompt_cache_key, undefined);
  assert.ok(!("promptCacheKey" in off));
});

test("openai-responses: usage reports cached and missed input", () => {
  assert.deepEqual(usageOf({ input_tokens: 1000, output_tokens: 4, input_tokens_details: { cached_tokens: 900 } }), {
    inputTokens: 1000,
    outputTokens: 4,
    cachedTokens: 900,
    cacheMissTokens: 100,
  });
});
