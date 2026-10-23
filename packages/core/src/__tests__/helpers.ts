import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SintyEvent } from "@sinty/sdk";
import type { SintyConfig, SintyPolicy } from "../config.js";
import { initHome, Sinty } from "../sinty.js";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test-fixtures", "plugins");

export interface ScriptStep {
  text?: string;
  toolCalls?: { name: string; args: unknown }[];
  echoLastTool?: boolean;
  /** Usage the fake provider reports for this step (default 10 in, 5 out). */
  usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number };
}

export function tempHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "sinty-test-"));
  initHome(home);
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export function testConfig(script: ScriptStep[], extra: Partial<SintyConfig> = {}, plugins = ["fake-provider", "test-tools"]): Partial<SintyConfig> {
  // responsive-turn is DEFAULT_ON in production; tests that assert exact prompt prefixes disable it
  // here. Enable it in a test with plugins.disabled that omits it (see responsive-turns.test.ts).
  const basePlugins = { enabled: plugins, disabled: ["responsive-turn"], config: {}, searchPaths: [FIXTURES] };
  const merged: Partial<SintyConfig> = {
    providers: { fake: { protocol: "fake", options: { script } } },
    models: { default: "fake/test-model", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
    plugins: basePlugins,
    ...extra,
  };
  if (extra.plugins) {
    merged.plugins = {
      ...basePlugins,
      ...extra.plugins,
      enabled: extra.plugins.enabled ?? basePlugins.enabled,
      // Union: keep the test-helper default (responsive-turn off) plus any test-specific disables.
      disabled: [...new Set([...(basePlugins.disabled ?? []), ...(extra.plugins.disabled ?? [])])],
      searchPaths: extra.plugins.searchPaths ?? basePlugins.searchPaths,
      config: extra.plugins.config ?? basePlugins.config,
    };
  }
  return merged;
}

export async function boot(home: string, script: ScriptStep[], opts: { config?: Partial<SintyConfig>; policy?: Partial<SintyPolicy>; plugins?: string[] } = {}): Promise<Sinty> {
  const sinty = new Sinty({ home, config: testConfig(script, opts.config, opts.plugins), ...(opts.policy ? { policy: opts.policy } : {}) });
  const { failedPlugins } = await sinty.start();
  const unexpected = failedPlugins.filter((f) => f.plugin !== "greedy");
  if (unexpected.length) {
    await sinty.stop();
    throw new Error(`plugins failed: ${JSON.stringify(unexpected)}`);
  }
  return sinty;
}

/** Event types of the turn flow; bookkeeping events (state, usage, turn context, memory snapshot) are left out. */
export function types(events: SintyEvent[]): string[] {
  const skip = new Set(["agent.state", "usage.recorded", "context.turn", "memory.snapshot"]);
  return events.map((e) => e.type).filter((t) => !skip.has(t));
}

export function find<T = Record<string, unknown>>(events: SintyEvent[], type: string): T | undefined {
  return events.find((e) => e.type === type)?.data as T | undefined;
}
