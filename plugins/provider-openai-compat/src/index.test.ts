import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderRequest } from "@sinty/sdk";
import { buildBody, transcriptionOf, usageOf } from "./index.js";

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

test("openai-compat: reasoning off disables DeepSeek thinking and sets no max_tokens", () => {
  const off = buildBody({ ...req("https://api.deepseek.com/v1"), reasoning: "off" });
  assert.deepEqual(off.thinking, { type: "disabled" });
  assert.equal(off.reasoning_effort, undefined);
  assert.equal(off.max_tokens, undefined);
  const on = buildBody({ ...req("https://api.deepseek.com/v1"), reasoning: "medium" });
  assert.deepEqual(on.thinking, { type: "enabled" });
  assert.equal(on.reasoning_effort, "medium");
  const openai = buildBody({ ...req("https://api.openai.com/v1"), reasoning: "off" });
  assert.equal(openai.thinking, undefined);
});

test("openai-compat: transcription JSON keeps text, language and duration", () => {
  assert.deepEqual(transcriptionOf({ text: "  привет  ", language: "ru", duration: 1.5 }, 2000), {
    text: "привет",
    language: "ru",
    durationSec: 1.5,
    usage: { inputTokens: 2, outputTokens: 2 },
  });
  assert.equal(transcriptionOf({ text: "" }, 10).text, "");
  assert.throws(() => transcriptionOf({ error: { message: "no" } }, 10), /no/);
});

test("openai-compat: verbose transcription keeps words, times and speakers", () => {
  const parsed = transcriptionOf({
    text: "hello there",
    segments: [
      { text: " hello", start: 0, end: 1.2, speaker: "A" },
      { text: " there", start: 1.2, end: 2, speaker: "B" },
    ],
    words: [
      { word: "hello", start: 0.1, end: 0.4 },
      { word: "there", start: 1.3, end: 1.8 },
    ],
  }, 1000);
  assert.equal(parsed.segments?.length, 2);
  assert.equal(parsed.segments?.[0]?.speaker, "A");
  assert.deepEqual(parsed.segments?.[0]?.words, [{ text: "hello", start: 0.1, end: 0.4 }]);
  assert.equal(parsed.segments?.[1]?.speaker, "B");
  assert.deepEqual(parsed.segments?.[1]?.words, [{ text: "there", start: 1.3, end: 1.8 }]);
});

test("openai-compat: Qwen Omni audio is a data URI and the reply is text", () => {
  const body = buildBody({
    ...req("https://llm.runninghub.ai/v1"),
    model: "qwen/qwen3.8-omni-flash",
    messages: [{ role: "user", content: "what is this", audio: [{ mime: "audio/mpeg", data: "QQ==" }] }],
  });
  const messages = body.messages as { content: { input_audio?: { data: string } }[] }[];
  assert.equal(messages[0]?.content[1]?.input_audio?.data, "data:;base64,QQ==");
  assert.deepEqual(body.modalities, ["text"]);
});

test("openai-compat: audio rides along as input_audio", () => {
  const body = buildBody({
    ...req("https://api.openai.com/v1"),
    messages: [{ role: "user", content: "what is this", audio: [{ mime: "audio/mpeg", data: "QQ==" }] }],
  });
  const messages = body.messages as { content: unknown }[];
  assert.deepEqual(messages[0]?.content, [
    { type: "text", text: "what is this" },
    { type: "input_audio", input_audio: { data: "QQ==", format: "mp3" } },
  ]);
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

test("openai-compat: GET /models windows from OpenRouter, Groq, vLLM; ids only from OpenAI and DeepSeek", async () => {
  const { openAIModelList } = await import("@sinty/sdk");
  assert.deepEqual(
    openAIModelList({
      data: [
        { id: "deepseek-flash", object: "model", owned_by: "deepseek" },
        { id: "or/model", context_length: 131072, top_provider: { context_length: 65536, max_completion_tokens: 8192 } },
        { id: "groq/model", context_window: 131072, max_completion_tokens: 32768 },
        { id: "vllm/model", max_model_len: 32768 },
        { id: "bad", context_length: -1 },
      ],
    }),
    [{ id: "deepseek-flash" }, { id: "or/model", contextWindow: 131072, maxOutputTokens: 8192 }, { id: "groq/model", contextWindow: 131072, maxOutputTokens: 32768 }, { id: "vllm/model", contextWindow: 32768 }, { id: "bad" }],
  );
  assert.deepEqual(openAIModelList({ error: "x" }), []);
});
