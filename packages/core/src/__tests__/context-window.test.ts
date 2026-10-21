import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ContextSnapshot, SintyEvent } from "@sinty/sdk";
import { configSchema, type SintyConfig } from "../config.js";
import { ContextWindows, FALLBACK_CONTEXT_WINDOW, knownContextWindow, ratioFromEvents, tokenRatio } from "../context-window.js";
import { createApp } from "../api/server.js";
import type { Sinty } from "../sinty.js";
import { boot, FIXTURES, tempHome } from "./helpers.js";

/** Context window auto-detection (docs/journal/2026-10-22-context-window.md). */

const parse = (raw: Record<string, unknown>): SintyConfig => configSchema.parse(raw);

test("context window: memory.contextTokens wins, then models.contextWindows, the provider list, the table, 128000", () => {
  const { home, cleanup } = tempHome();
  try {
    const dataDir = join(home, "data");
    const auto = parse({ models: { default: "deepseek/deepseek-flash", contextWindows: { "local/qwen": 32768 } }, providers: { deepseek: { protocol: "openai-compat" }, local: { protocol: "openai-compat" } } });
    assert.equal(auto.memory.contextTokens, "auto", "auto is the default");
    const w = new ContextWindows({ dataDir, config: auto });
    assert.deepEqual(w.resolve("deepseek/deepseek-flash"), { tokens: 1_000_000, source: "table", route: "deepseek/deepseek-flash" });
    assert.deepEqual(w.resolve("local/qwen"), { tokens: 32768, source: "route", route: "local/qwen" });
    assert.deepEqual(w.resolve("local/unknown-model"), { tokens: FALLBACK_CONTEXT_WINDOW, source: "fallback", route: "local/unknown-model" });
    assert.deepEqual(w.resolve(undefined), { tokens: FALLBACK_CONTEXT_WINDOW, source: "fallback" });
    const fixed = parse({ memory: { contextTokens: 64000 }, models: { contextWindows: { "local/qwen": 32768 } } });
    assert.deepEqual(new ContextWindows({ dataDir, config: fixed }).resolve("local/qwen"), { tokens: 64000, source: "config" }, "an explicit number overrides every model");
    assert.throws(() => parse({ memory: { contextTokens: "big" } }), "only a number or auto");
  } finally {
    cleanup();
  }
});

test("context window: the table matches exact ids and dated snapshots, nothing else", () => {
  assert.equal(knownContextWindow("deepseek-v4-pro"), 1_000_000);
  assert.equal(knownContextWindow("DeepSeek-Flash"), 1_000_000);
  assert.equal(knownContextWindow("gpt-4o"), 128_000);
  assert.equal(knownContextWindow("gpt-4o-2024-08-06"), 128_000);
  assert.equal(knownContextWindow("gpt-4o-mini"), undefined, "a different model with the same prefix is not guessed");
  assert.equal(knownContextWindow("gpt-5"), 272_000, "the input limit, not the 400k window that includes output");
  assert.equal(knownContextWindow("claude-sonnet-4-5"), undefined, "Anthropic reports its windows through the Models API");
});

test("context window: estimate ratio from usage, ignored when implausible", () => {
  assert.equal(tokenRatio(1000, 1330), 1.33);
  assert.equal(tokenRatio(1000, 10), undefined, "a test provider's constant usage is not a tokenizer");
  assert.equal(tokenRatio(undefined, 500), undefined);
  const ev = (type: string, stepId: string, data: Record<string, unknown>) => ({ type, stepId, data }) as unknown as SintyEvent;
  assert.equal(
    ratioFromEvents([ev("model.request", "s1", { estTokens: 1000 }), ev("usage.recorded", "s1", { inputTokens: 1500 }), ev("model.request", "s2", { estTokens: 2000 }), ev("usage.recorded", "s2", { inputTokens: 2600 })]),
    1.3,
    "the newest step",
  );
  assert.equal(ratioFromEvents([ev("model.request", "s1", {}), ev("usage.recorded", "s1", { inputTokens: 1500 })]), undefined, "journals without estTokens");
});


function recConfig(options: Record<string, unknown>, extra: Partial<SintyConfig> = {}): Partial<SintyConfig> {
  return {
    providers: { rec: { protocol: "rec", options: { summary: { summary: "Earlier questions.", facts: [] }, ...options } } },
    models: { default: "rec/cache-model", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
    plugins: { enabled: ["recording-provider"], config: {}, searchPaths: [FIXTURES] },
    ...extra,
  };
}

async function talk(sinty: Sinty, turns: number): Promise<SintyEvent[]> {
  const s = sinty.agent.createSession();
  for (let i = 0; i < turns; i++) {
    sinty.agent.send(s.id, `question ${i}: ${"padding ".repeat(30)}`);
    await sinty.agent.idle();
  }
  return sinty.journal.events(s.id);
}

const folds = (events: SintyEvent[]): number => events.filter((e) => e.type === "memory.compacted").length;

test("context window: the provider's model list sets the window, is cached in data/, and compaction folds at 65% of it", async () => {
  const { home, cleanup } = tempHome();
  const models = [{ id: "cache-model", contextWindow: 6000 }];
  const sinty = await boot(home, [], { config: recConfig({ models }), plugins: ["recording-provider"] });
  try {
    await sinty.windows.refresh("rec");
    assert.deepEqual(sinty.windows.resolve("rec/cache-model"), { tokens: 6000, source: "provider", route: "rec/cache-model" });
    const cache = JSON.parse(readFileSync(join(home, "data", "context-windows.json"), "utf8")) as { providers: Record<string, { models: Record<string, number> }> };
    assert.deepEqual(cache.providers.rec!.models, { "cache-model": 6000 });
    const events = await talk(sinty, 40);
    assert.ok(folds(events) >= 1, "40 padded turns pass 65% of a 6000-token window");
    const req = events.find((e) => e.type === "model.request")!.data as { estTokens?: number };
    assert.ok(req.estTokens && req.estTokens > 0, "model.request carries the core's estimate");

    const api = createApp(sinty);
    const r = (await (await api.request("/v1/models", { headers: { authorization: `Bearer ${sinty.secrets.get("api.token")!}` } })).json()) as { models: { route: string; contextWindow: { tokens: number; source: string } }[] };
    assert.deepEqual(r.models[0]!.contextWindow, { tokens: 6000, source: "provider", route: "rec/cache-model" });
  } finally {
    await sinty.stop();
  }
  // After a restart the cached list answers at once, without the plugin.
  const again = new ContextWindows({ dataDir: join(home, "data"), config: parse({ providers: { rec: { protocol: "rec" } } }) });
  assert.equal(again.resolve("rec/cache-model").tokens, 6000);
  cleanup();
});

test("context window: without a list the same session is not folded (128000 fallback); the list is asked once", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { config: recConfig({}), plugins: ["recording-provider"] });
  try {
    const events = await talk(sinty, 40);
    assert.equal(folds(events), 0);
    assert.deepEqual(sinty.windows.resolve("rec/cache-model"), { tokens: FALLBACK_CONTEXT_WINDOW, source: "fallback", route: "rec/cache-model" });
    const lists = join(home, "data", "recording-provider", "lists.jsonl");
    assert.ok(existsSync(lists));
    assert.equal(readFileSync(lists, "utf8").trim().split("\n").length, 1, "a failing list is not retried every turn");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("context window: a provider that counts more tokens than chars/4 (Cyrillic) makes compaction fold earlier", async () => {
  const run = async (inputScale: number | undefined): Promise<number> => {
    const { home, cleanup } = tempHome();
    const sinty = await boot(home, [], { config: recConfig(inputScale ? { inputScale } : {}, { memory: { contextTokens: 12000, dimensions: 1536 } as SintyConfig["memory"] }), plugins: ["recording-provider"] });
    try {
      return folds(await talk(sinty, 40));
    } finally {
      await sinty.stop();
      cleanup();
    }
  };
  assert.equal(await run(undefined), 0, "by the estimate alone 40 turns stay under 65% of 12000");
  assert.ok((await run(2)) >= 1, "with the provider counting twice the estimate they do not");
});

test("context window: the inspector snapshot carries the window, its source and the fold threshold", async () => {
  const { home, cleanup } = tempHome();
  const config = recConfig({ models: [{ id: "cache-model", contextWindow: 200000 }], inputScale: 1.3 }, {});
  config.plugins = { enabled: ["recording-provider", "inspect-test"], config: {}, searchPaths: [FIXTURES], inspect: ["inspect-test"] } as SintyConfig["plugins"];
  const sinty = await boot(home, [], { config, plugins: ["recording-provider", "inspect-test"] });
  try {
    await sinty.windows.refresh("rec");
    await talk(sinty, 2);
    const file = join(home, "data", "inspect-test", "snapshots.jsonl");
    const snaps = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ContextSnapshot);
    assert.deepEqual(snaps[0]!.window, { tokens: 200000, source: "provider", compactAt: 130000 });
    assert.equal(snaps.at(-1)!.window!.ratio, 1.3, "from the second step on, the ratio of the previous step");
  } finally {
    await sinty.stop();
    cleanup();
  }
});
