import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderRequest } from "@sinty/sdk";
import { buildBody, usageOf } from "./index.js";

const req = (baseUrl: string, options?: Record<string, unknown>): ProviderRequest => ({
  endpoint: { baseUrl, ...(options ? { options } : {}) },
  model: "m",
  messages: [
    { role: "system", content: "rules", cacheHint: "static" },
    { role: "user", content: "hi", cacheHint: "turn" },
  ],
  tools: [],
  cacheKey: "sinty-abc",
  signal: new AbortController().signal,
});

test("openai-compat: cache hints never reach the wire", () => {
  const body = buildBody(req("http://localhost:1234/v1"));
  assert.deepEqual(body.messages, [
    { role: "system", content: "rules" },
    { role: "user", content: "hi" },
  ]);
});

test("openai-compat: prompt_cache_key is sent to api.openai.com and when enabled, never as a raw option", () => {
  assert.equal(buildBody(req("http://localhost:1234/v1")).prompt_cache_key, undefined);
  assert.equal(buildBody(req("https://api.openai.com/v1")).prompt_cache_key, "sinty-abc");
  assert.equal(buildBody(req("https://api.openai.com/v1", { promptCacheKey: false })).prompt_cache_key, undefined);
  const on = buildBody(req("https://api.deepseek.com/v1", { promptCacheKey: true, temperature: 0 }));
  assert.equal(on.prompt_cache_key, "sinty-abc");
  assert.equal(on.temperature, 0);
  assert.ok(!("promptCacheKey" in on));
});

test("openai-compat: usage reads DeepSeek hit/miss fields and OpenAI cached_tokens", () => {
  assert.deepEqual(usageOf({ prompt_tokens: 1000, completion_tokens: 5, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 }), {
    inputTokens: 1000,
    outputTokens: 5,
    cachedTokens: 900,
    cacheMissTokens: 100,
  });
  assert.deepEqual(usageOf({ prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 768 } }), {
    inputTokens: 1000,
    outputTokens: 5,
    cachedTokens: 768,
    cacheMissTokens: 232,
  });
  assert.deepEqual(usageOf({ prompt_tokens: 10, completion_tokens: 1 }), { inputTokens: 10, outputTokens: 1 });
});
