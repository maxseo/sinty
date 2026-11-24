import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { modelProfileSchema, modelProfilesSchema, resolveModelProfile, generationControls, validateProfile, type ModelProfiles } from "../model-profile.js";
import { saveAgent, loadRoster } from "../roster.js";
import { resolvePaths } from "../paths.js";
import { configSchema, policySchema } from "../config.js";
import { createApp } from "../api/server.js";
import { ModelGateway, type GatewayDeps } from "../models.js";
import { Agent, type AgentDeps } from "../agent.js";
import type { Sinty } from "../sinty.js";
import type { ProviderRequest, ProviderDefinition, ProviderChunk, PluginContext } from "@sinty/sdk";

const provider = { protocol: "openai-compat", options: { temperature: 0.8, toolCallNameMode: "catalog-compatible" } };
test("profiles: inherit current global output limit, preserve absent payload/options identity, keep zero and isolate full routes", () => {
  assert.deepEqual(resolveModelProfile(provider, undefined, "rh/a", 250000), { maxOutputTokens: 250000, options: provider.options });
  assert.equal(resolveModelProfile(provider, {}, "rh/a", 7000).options, provider.options);
  const profiles = { "rh/a": { maxOutputTokens: 123, advanced: true as const, temperature: 0 }, "other/a": { maxOutputTokens: 999 } };
  assert.deepEqual(resolveModelProfile(provider, profiles, "rh/a", 7000), { maxOutputTokens: 123, options: { temperature: 0, toolCallNameMode: "catalog-compatible" } });
  assert.equal(resolveModelProfile(provider, profiles, "other/a", 7000).maxOutputTokens, 999);
  assert.equal(resolveModelProfile(provider, profiles, "rh/b", 7000).maxOutputTokens, 7000);
  const sampling = { "rh/a": { advanced: true as const, temperature: 0 } };
  assert.equal(resolveModelProfile(provider, sampling, "rh/a", 7000).maxOutputTokens, 7000);
  assert.equal(resolveModelProfile(provider, sampling, "rh/a", 9000).maxOutputTokens, 9000);
  assert.equal(provider.options.temperature, 0.8, "provider defaults are not mutated");
});
test("profiles: strict validated whitelist, finite bounds, positive safe integer output, explicit advanced acknowledgement", () => {
  for (const bad of [{ maxOutputTokens: 0 }, { maxOutputTokens: -1 }, { maxOutputTokens: 1.5 }, { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 }, { maxOutputTokens: Infinity }, { temperature: 0 }, { advanced: true, temperature: NaN }, { advanced: true, temperature: 3 }, { advanced: true, top_p: 0 }, { advanced: true, top_k: 1.5 }, { advanced: true, presence_penalty: 3 }, { messages: [] }, { stream: false }, { options: { model: "forged" } }, { advanced: true, repeat_penalty: 1, repetition_penalty: 1 }, { advanced: true, promptCache: false, cacheTtl: "1h" }]) assert.equal(modelProfileSchema.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(modelProfileSchema.parse({ advanced: true, temperature: 0 }).temperature, 0);
  assert.equal(modelProfilesSchema.safeParse({ "unqualified": {} }).success, false);
  assert.equal(modelProfilesSchema.safeParse({ "RH/a": {} }).success, false);
});
test("profiles: protocol validation and concrete reasoning/cache semantics never pretend universal off", () => {
  const anthropic = { protocol: "anthropic", options: { max_tokens: 1, thinking: { type: "disabled" } } };
  assert.throws(() => validateProfile({ advanced: true, top_k: 5 }, { protocol: "openai-responses" }, 8192));
  assert.throws(() => validateProfile({ advanced: true, reasoningEffort: "off" }, provider, 8192));
  assert.throws(() => validateProfile({ advanced: true, temperature: 1.1 }, anthropic, 8192));
  assert.throws(() => validateProfile({ advanced: true, thinkingBudgetTokens: 4096 }, anthropic, 2048));
  assert.throws(() => validateProfile({ advanced: true, thinkingBudgetTokens: 1024, temperature: 1 }, anthropic, 2048));
  assert.equal(generationControls(provider).modelSupport, "unknown");
  assert.equal(generationControls({ protocol: "openai-compat", baseUrl: "https://notapi.deepseek.com/v1" }).reasoningOff, false);
  const p: ModelProfiles = { "a/m": { advanced: true, thinkingBudgetTokens: 1024, maxOutputTokens: 2048, promptCache: true, cacheTtl: "1h" } };
  const a = resolveModelProfile(anthropic, p, "a/m", 99);
  assert.equal(a.options?.max_tokens, 2048);
  assert.deepEqual(a.options?.thinking, { type: "enabled", budget_tokens: 1024 });
  assert.equal(a.options?.cacheTtl, "1h");
  const d = resolveModelProfile({ protocol: "openai-compat", baseUrl: "https://api.deepseek.com/v1", options: { reasoning_effort: "high" } }, { "d/m": { advanced: true, reasoningEffort: "off" } }, "d/m", 8192);
  assert.deepEqual(d.options?.thinking, { type: "disabled" }); assert.equal(d.options?.reasoning_effort, undefined);
  const r = resolveModelProfile({ protocol: "openai-responses", options: { reasoning: { summary: "concise", unrelated: true } } }, { "r/m": { advanced: true, reasoningEffort: "low", promptCacheKey: false } }, "r/m", 8192);
  assert.deepEqual(r.options?.reasoning, { summary: "auto", unrelated: true, effort: "low" }); assert.equal(r.options?.promptCacheKey, false);
});
test("profiles: roster backward compatibility, persistence, merge preservation and reset do not overwrite persona", () => {
  const home = mkdtempSync(join(tmpdir(), "sinty-profiles-")), paths = resolvePaths(home);
  try {
    const agent = saveAgent(paths, { name: "Fixture", persona: "keep", model: "rh/a" });
    assert.equal(agent.modelProfiles, undefined);
    saveAgent(paths, { id: agent.id, name: agent.name, modelProfiles: { "rh/a": { maxOutputTokens: 123 } } });
    assert.equal(loadRoster(paths).agents[0]!.modelProfiles?.["rh/a"]?.maxOutputTokens, 123);
    saveAgent(paths, { id: agent.id, name: agent.name, summary: "edited" });
    assert.equal(loadRoster(paths).agents[0]!.modelProfiles?.["rh/a"]?.maxOutputTokens, 123);
    saveAgent(paths, { id: agent.id, name: agent.name, modelProfiles: {} });
    assert.equal(loadRoster(paths).agents[0]!.persona, "keep");
    assert.deepEqual(loadRoster(paths).agents[0]!.modelProfiles, {});
    const raw = JSON.parse(readFileSync(join(paths.data, "roster.json"), "utf8")); raw.agents[0].modelProfiles = { broken: { maxOutputTokens: -1 } }; writeFileSync(join(paths.data, "roster.json"), JSON.stringify(raw));
    assert.equal(loadRoster(paths).agents[0]!.persona, "keep", "an invalid optional profile never hides the roster");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test("profiles API: actual create/update validate before writes and metadata strips endpoint options/secrets", async () => {
  const home = mkdtempSync(join(tmpdir(), "sinty-profiles-api-")), paths = resolvePaths(home);
  const config = configSchema.parse({ providers: { rh: provider, native: { protocol: "anthropic", apiKey: "secret://fixture", options: { private: "MUST-NOT-LEAK" } } }, models: { default: "rh/a", maxOutputTokens: 7777 } });
  const app = createApp({ paths, config, secrets: { resolve: () => "fixture-only" }, accounts: { userByToken: () => undefined, noteResources: () => {} }, host: { plugins: new Map() }, policy: policySchema.parse({}), windows: { resolve: () => ({ tokens: 128000, source: "fallback" }) } } as unknown as Sinty);
  const headers = { authorization: "Bearer fixture-only", "content-type": "application/json" };
  const request = (path: string, method: string, body: unknown) => app.request(path, { method, headers, body: JSON.stringify(body) });
  try {
    const good = await request("/v1/roster/agents", "POST", { name: "API fixture", persona: "keep", modelProfiles: { "rh/a": { advanced: true, temperature: 0, maxOutputTokens: 321 } } }); assert.equal(good.status, 201);
    const saved = await good.json() as { id: string; modelProfiles: ModelProfiles };
    assert.equal(saved.modelProfiles["rh/a"]!.temperature, 0);
    const before = readFileSync(join(paths.data, "roster.json"), "utf8");
    for (const modelProfiles of [{ "rh/a": { maxOutputTokens: 0 } }, { "rh/a": { advanced: true, reasoningEffort: "off" } }, { "native/a": { advanced: true, frequency_penalty: 1 } }, { "missing/a": { maxOutputTokens: 100 } }, { "rh/a": { advanced: true, model: "body-overwrite" } }]) { const bad = await request("/v1/roster/agents/" + saved.id, "PUT", { name: "bad", modelProfiles }); assert.equal(bad.status, 400); assert.equal(readFileSync(join(paths.data, "roster.json"), "utf8"), before); }
    const metadata = await (await app.request("/v1/models", { headers })).json() as { generation: { maxOutputTokens: number } };
    assert.equal(metadata.generation.maxOutputTokens, 7777); assert(!JSON.stringify(metadata).includes("MUST-NOT-LEAK"));
    assert.equal((await request("/v1/roster/agents/" + saved.id, "PUT", { name: "API fixture", modelProfiles: {} })).status, 200);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("profiles: actual main/fallback stream requests and window reservation resolve each route independently", async () => {
  const sent: { protocol: string; req: Omit<ProviderRequest, "signal"> }[] = [];
  const config = configSchema.parse({ providers: { p: provider, f: { protocol: "openai-responses" } }, models: { default: "p/primary", fallback: ["f/secondary"], maxOutputTokens: 10000 } });
  const profiles: ModelProfiles = { "p/primary": { advanced: true, temperature: 0, maxOutputTokens: 120 }, "f/secondary": { advanced: true, top_p: 0.5, maxOutputTokens: 500 } };
  const speaker = { model: "p/primary", fallback: "", modelProfiles: profiles };
  const agent = new Agent({ config, paths: resolvePaths(join(tmpdir(), "not-created-profiles-window")), windows: { resolve: () => ({ tokens: 5000, source: "config" }) }, host: { inspectors: () => [], providerFor: () => ({ async *streamProvider(protocol: string, req: Omit<ProviderRequest, "signal">) { sent.push({ protocol, req }); if (req.model === "primary") throw new Error("synthetic outage"); yield { type: "done", stopReason: "stop", usage: { inputTokens: 10, outputTokens: 1 } }; } }) }, secrets: { resolve: () => undefined } } as unknown as AgentDeps);
  const events: unknown[] = [];
  Object.assign(agent, { speaker: () => speaker, buildContext: async () => [{ role: "user", content: "synthetic" }], allowedTools: () => undefined, toolSchemas: () => [], pluginVisible: () => true, record: (event: unknown) => events.push(event), tokenRatio: () => 1 });
  const harness = agent as unknown as { callModel(s: string, t: string, signal: AbortSignal): Promise<void>; fitWindow(s: string, route: string, m: unknown[], t: unknown[], est: number, reserve?: number): { ok: boolean } };
  await harness.callModel("s", "t", new AbortController().signal);
  assert.equal(sent.length, 2); assert.equal(sent[0]!.req.maxOutputTokens, 120); assert.equal(sent[0]!.req.endpoint.options?.temperature, 0);
  assert.equal(sent[1]!.req.maxOutputTokens, 500); assert.equal(sent[1]!.req.endpoint.options?.top_p, 0.5); assert.equal(sent[1]!.req.endpoint.options?.temperature, undefined);
  assert.equal(harness.fitWindow("s", "f/secondary", [], [], 4400, resolveModelProfile(config.providers.f!, profiles, "f/secondary", config.models.maxOutputTokens).maxOutputTokens).ok, true);
  profiles["f/secondary"]!.maxOutputTokens = 900;
  assert.equal(harness.fitWindow("s", "f/secondary", [], [], 4400).ok, false);
  delete profiles["f/secondary"];
  assert.equal(harness.fitWindow("s", "f/secondary", [], [], 4400).ok, false, "reset inherits 10000, not the primary's 120");
});

for (const [folder, protocol, profile, expected] of [
  ["provider-openai-compat", "openai-compat", { advanced: true, temperature: 0, top_k: 20, maxOutputTokens: 333 }, { temperature: 0, top_k: 20, max_tokens: 333 }],
  ["provider-anthropic", "anthropic", { advanced: true, temperature: 0, maxOutputTokens: 444, promptCache: false }, { temperature: 0, max_tokens: 444 }],
  ["provider-openai-responses", "openai-responses", { advanced: true, temperature: 0, maxOutputTokens: 555, reasoningEffort: "low", promptCacheKey: false }, { temperature: 0, max_output_tokens: 555 }],
] as const) test("profiles real " + protocol + " adapter: transmitted options and limit precedence through mocked fetch only", async () => {
  const module = await import(new URL("../../../../plugins/" + folder + "/dist/index.js", import.meta.url).href) as { default: { setup(ctx: PluginContext): void }; buildBody(req: ProviderRequest): Record<string, unknown> };
  const defs: ProviderDefinition[] = [];
  module.default.setup({ net: { fetch: (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => globalThis.fetch(url, init) }, provider: (definition: ProviderDefinition) => defs.push(definition) } as unknown as PluginContext);
  const settings = resolveModelProfile({ protocol, options: { ...(protocol === "openai-responses" ? { max_output_tokens: 2 } : { max_tokens: 1 }), temperature: 0.9 } }, { "p/model": profile }, "p/model", 999);
  const req: ProviderRequest = { endpoint: { baseUrl: "https://mock.invalid/v1", ...(settings.options ? { options: settings.options } : {}) }, model: "model", messages: [{ role: "user", content: "synthetic" }], tools: [], maxOutputTokens: settings.maxOutputTokens, cacheKey: "synthetic-key", signal: new AbortController().signal };
  let body: Record<string, unknown> | undefined;
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => { assert.match(String(url), /^https:\/\/mock\.invalid\//); body = JSON.parse(String(init?.body)); const data = protocol === "anthropic" ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n' : protocol === "openai-responses" ? 'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n' : 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n'; return new Response(data, { headers: { "content-type": "text/event-stream" } }); };
  try { const chunks: ProviderChunk[] = []; for await (const chunk of defs.find(d => d.protocol === protocol)!.stream(req)) chunks.push(chunk); assert(chunks.some(c => c.type === "done")); for (const [k, value] of Object.entries(expected)) assert.deepEqual(body?.[k], value); if (protocol === "openai-responses") { assert.equal(body?.prompt_cache_key, undefined); assert.deepEqual(body?.reasoning, { effort: "low", summary: "auto" }); } assert.equal(body?.advanced, undefined); assert.equal(body?.maxOutputTokens, undefined); }
  finally { globalThis.fetch = previous; }
});


test("profiles: unrelated ctx.models.complete keeps provider defaults and its own explicit limit", async () => {
  const requests: Record<string, unknown>[] = [];
  const config = configSchema.parse({ providers: { p: provider }, models: { default: "p/a", maxOutputTokens: 7777 } });
  const gateway = new ModelGateway({ config, secrets: { resolve: () => undefined }, host: { providerFor: () => ({ async *streamProvider(_protocol: string, req: Record<string, unknown>) { requests.push(req); yield { type: "done", stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }; } }) } } as unknown as GatewayDeps);
  await gateway.pluginCall("fixture", ["p/a"], "complete", { route: "p/a", messages: [], maxOutputTokens: 99, temperature: 0, modelProfiles: { "p/a": { maxOutputTokens: 1234 } } });
  assert.equal(requests[0]!.maxOutputTokens, 99);
  assert.deepEqual((requests[0]!.endpoint as { options: unknown }).options, provider.options);
  assert.equal(requests[0]!.temperature, undefined);
});


test("profiles: known conflicts include inherited Anthropic defaults and alternate penalty names", () => {
  assert.throws(() => validateProfile({ advanced: true, thinkingBudgetTokens: 1024 }, { protocol: "anthropic", options: { temperature: 0.5 } }, 4096));
  assert.throws(() => validateProfile({ advanced: true, temperature: 0 }, { protocol: "anthropic", options: { thinking: { type: "adaptive" } } }, 4096));
  assert.throws(() => validateProfile({ maxOutputTokens: 2000 }, { protocol: "anthropic", options: { thinking: { type: "enabled", budget_tokens: 2048 } } }, 4096));
  const resolved = resolveModelProfile({ protocol: "openai-compat", options: { repeat_penalty: 1.1 } }, { "p/a": { advanced: true, repetition_penalty: 1.2 } }, "p/a", 1000);
  assert.equal(resolved.options?.repeat_penalty, undefined); assert.equal(resolved.options?.repetition_penalty, 1.2);
  assert.equal(modelProfilesSchema.parse({ "rh/anthropic/model": { maxOutputTokens: 9 } })["rh/anthropic/model"]!.maxOutputTokens, 9);
});
