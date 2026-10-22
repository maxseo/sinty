import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SintyEvent } from "@sinty/sdk";
import type { SintyConfig } from "./config.js";
import type { PluginHost } from "./host/host.js";
import type { ProviderWireRequest } from "./host/protocol.js";
import type { SecretStore } from "./secrets.js";

/** Used when nothing else knows the model (the old memory.contextTokens default). */
export const FALLBACK_CONTEXT_WINDOW = 128_000;
/** The dialogue is folded into a summary at this share of the window (memory-router.ts compact). */
export const COMPACT_AT = 0.65;
/**
 * memory.compactCapTokens default: fold no later than this many real tokens of dialogue, whatever the window. A 1M
 * window would otherwise fold at 650k, and every step of a long chat re-sends (and pays for) all of it.
 */
export const DEFAULT_COMPACT_CAP = 150_000;

/** Where the dialogue is folded: 65% of the window or the cap, whichever comes first (real tokens). */
export interface CompactPoint {
  tokens: number;
  by: "window" | "cap";
  /** The cap in effect, when there is one. */
  cap?: number;
}

/** memory.compactCapTokens: absent → DEFAULT_COMPACT_CAP; 0 or null → no cap. */
export function compactCap(config: SintyConfig): number | undefined {
  const v = config.memory.compactCapTokens;
  if (v === undefined) return DEFAULT_COMPACT_CAP;
  return v && v > 0 ? v : undefined;
}

export function compactPoint(window: number, cap: number | undefined): CompactPoint {
  const atWindow = Math.floor(window * COMPACT_AT);
  if (cap && cap < atWindow) return { tokens: cap, by: "cap", cap };
  return { tokens: atWindow, by: "window", ...(cap ? { cap } : {}) };
}

/**
 * The `sinty doctor` line for a route's window and where its dialogue is folded, from the same compactPoint() the
 * memory router uses, saying whether memory.compactCapTokens or 65% of the window applies.
 */
export function describeCompaction(route: string, w: ContextWindow, config: SintyConfig): string {
  const point = compactPoint(w.tokens, compactCap(config));
  const atWindow = Math.floor(w.tokens * COMPACT_AT);
  const source = `${w.source}${w.source === "fallback" ? ": unknown model, set models.contextWindows or memory.contextTokens" : ""}`;
  const why =
    point.by === "cap"
      ? `memory.compactCapTokens; 65% of the window would be ${atWindow}`
      : `65% of the window; ${point.cap ? `memory.compactCapTokens ${point.cap} is higher` : "no memory.compactCapTokens cap"}`;
  return `context window ${route}: ${w.tokens} tokens (${source}), summary at ${point.tokens} (${why})`;
}

/**
 * Input windows of models whose provider API does not report one (DeepSeek and OpenAI `/models` return ids only).
 * Every row names its source; checked 2026-10-22. Ids match exactly or with a dated snapshot suffix
 * (`gpt-4o-2024-08-06`). Anthropic's model list reports `max_input_tokens`, so Claude models need no row here.
 * Add a model only with a published number; use models.contextWindows in config.yaml for anything else.
 */
export const KNOWN_CONTEXT_WINDOWS: readonly { model: string; tokens: number; source: string; note?: string }[] = [
  // https://api-docs.deepseek.com/quick_start/pricing: "CONTEXT LENGTH 1M" for deepseek-flash (DeepSeek-V4.1-Flash)
  // and deepseek-v4-pro; https://www.deepseek.com/en/news/v4-preview/ "Both models support 1M context". The page
  // gives one "1M" for input and output together, taken literally as 1,000,000 (could be 1,048,576).
  { model: "deepseek-flash", tokens: 1_000_000, source: "api-docs.deepseek.com/quick_start/pricing" },
  { model: "deepseek-v4-pro", tokens: 1_000_000, source: "api-docs.deepseek.com/quick_start/pricing" },
  // Legacy name, still accepted and served by DeepSeek-V4.1-Flash (same pricing page, note 1).
  { model: "deepseek-v4-flash", tokens: 1_000_000, source: "api-docs.deepseek.com/quick_start/pricing", note: "legacy alias of deepseek-flash" },
  { model: "gpt-4.1", tokens: 1_047_576, source: "platform.openai.com/docs/models/gpt-4.1" },
  { model: "gpt-4o", tokens: 128_000, source: "platform.openai.com/docs/models/gpt-4o" },
  // 400,000 context window, of which at most 272,000 input tokens: the input limit is what matters here.
  { model: "gpt-5", tokens: 272_000, source: "platform.openai.com/docs/models/gpt-5", note: "maximum input tokens (window 400,000 incl. output)" },
];

export type WindowSource = "config" | "route" | "provider" | "table" | "fallback";

export interface ContextWindow {
  tokens: number;
  source: WindowSource;
  /** The route the window belongs to ("provider/model"); absent for a memory.contextTokens number. */
  route?: string;
}

export function knownContextWindow(model: string): number | undefined {
  const id = model.toLowerCase();
  for (const row of KNOWN_CONTEXT_WINDOWS) {
    if (id === row.model || (id.startsWith(row.model + "-") && /^\d{4}-\d{2}-\d{2}$/.test(id.slice(row.model.length + 1)))) return row.tokens;
  }
  return undefined;
}

interface CacheFile {
  version: 1;
  /** provider id → when it was asked and the windows it reported, by model id. */
  providers: Record<string, { at: string; baseUrl?: string; models: Record<string, number> }>;
}

export interface ContextWindowDeps {
  dataDir: string;
  config: SintyConfig;
  host?: PluginHost | undefined;
  secrets?: SecretStore | undefined;
  log?: ((level: string, msg: string, data?: unknown) => void) | undefined;
  /** How long a provider's list stays fresh. Default 24 h. */
  ttlMs?: number;
}

/**
 * Which context window a chat's model has. Order: memory.contextTokens (a number), models.contextWindows[route],
 * what the provider's listModels() reported (cached in data/context-windows.json), KNOWN_CONTEXT_WINDOWS, 128000.
 * resolve() never waits for the network: a miss starts a background refresh and the next turn sees the result.
 */
export class ContextWindows {
  private cache: CacheFile;
  private readonly file: string;
  private readonly inflight = new Map<string, Promise<void>>();
  /** Providers already asked in this process (also on failure), so a broken endpoint is not asked every turn. */
  private readonly asked = new Set<string>();

  constructor(private readonly d: ContextWindowDeps) {
    this.file = join(d.dataDir, "context-windows.json");
    this.cache = this.load();
  }

  resolve(route: string | undefined): ContextWindow {
    const fixed = this.d.config.memory.contextTokens;
    if (typeof fixed === "number") return { tokens: fixed, source: "config" };
    const r = route?.trim();
    if (!r) return { tokens: FALLBACK_CONTEXT_WINDOW, source: "fallback" };
    const own = this.d.config.models.contextWindows?.[r];
    if (own) return { tokens: own, source: "route", route: r };
    const slash = r.indexOf("/");
    const providerId = slash > 0 ? r.slice(0, slash) : r;
    const model = slash > 0 ? r.slice(slash + 1) : "";
    const entry = this.fresh(providerId);
    if (!entry) void this.refresh(providerId);
    const reported = this.cache.providers[providerId]?.models[model] ?? this.cache.providers[providerId]?.models[model.toLowerCase()];
    if (reported) return { tokens: reported, source: "provider", route: r };
    const known = model ? knownContextWindow(model) : undefined;
    if (known) return { tokens: known, source: "table", route: r };
    return { tokens: FALLBACK_CONTEXT_WINDOW, source: "fallback", route: r };
  }

  /** Asks the provider's plugin for its model list (once per provider at a time) and stores the windows it reports. */
  refresh(providerId: string): Promise<void> {
    const running = this.inflight.get(providerId);
    if (running) return running;
    if (this.asked.has(providerId)) return Promise.resolve();
    const prov = this.d.config.providers[providerId];
    const plugin = prov && this.d.host ? this.d.host.listerFor(prov.protocol) : undefined;
    if (!prov || !plugin) return Promise.resolve();
    this.asked.add(providerId);
    const job = (async () => {
      try {
        const apiKey = prov.apiKey ? this.d.secrets?.resolve(prov.apiKey) : undefined;
        if (prov.apiKey && !apiKey) return;
        const list = await plugin.listModelsProvider(prov.protocol, strip({ baseUrl: prov.baseUrl, apiKey, headers: prov.headers, options: prov.options }) as ProviderWireRequest["endpoint"]);
        const models: Record<string, number> = {};
        for (const m of list) if (m.contextWindow) models[m.id] = m.contextWindow;
        this.cache.providers[providerId] = { at: new Date().toISOString(), ...(prov.baseUrl ? { baseUrl: prov.baseUrl } : {}), models };
        this.save();
      } catch (e) {
        // A list that fails (offline, no /models on this endpoint) is not an error: the table and the fallback remain.
        this.d.log?.("debug", `context window: ${providerId} model list failed`, e instanceof Error ? e.message : e);
      } finally {
        this.inflight.delete(providerId);
      }
    })();
    this.inflight.set(providerId, job);
    return job;
  }

  /** Lets providers be asked again (after a settings change). */
  reset(): void {
    this.asked.clear();
  }

  /** Background refresh for the providers of models.default and models.fallback. */
  warm(): void {
    const routes = [this.d.config.models.default, ...this.d.config.models.fallback];
    for (const r of routes) {
      const slash = r ? r.indexOf("/") : -1;
      if (r && slash > 0 && !this.fresh(r.slice(0, slash))) void this.refresh(r.slice(0, slash));
    }
  }

  private fresh(providerId: string): boolean {
    const e = this.cache.providers[providerId];
    if (!e) return false;
    const prov = this.d.config.providers[providerId];
    if ((prov?.baseUrl ?? undefined) !== (e.baseUrl ?? undefined)) return false;
    return Date.now() - Date.parse(e.at) < (this.d.ttlMs ?? 24 * 3600_000);
  }

  private load(): CacheFile {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as CacheFile;
        if (raw && raw.version === 1 && raw.providers && typeof raw.providers === "object") return raw;
      }
    } catch {
      // A damaged cache is rebuilt on the next refresh.
    }
    return { version: 1, providers: {} };
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.cache, null, 2) + "\n");
      renameSync(tmp, this.file);
    } catch (e) {
      this.d.log?.("warn", "context window cache was not saved", e instanceof Error ? e.message : e);
    }
  }
}

function strip<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * chars/4 undercounts Cyrillic text by about a third, and over-counts some JSON. The provider's real prompt size
 * (`usage.inputTokens`) of the last step, divided by the estimate the core made for that same prompt
 * (`model.request.estTokens`), corrects the estimate. Ratios outside 0.5..3 are ignored (test providers, providers
 * that report no usage), as are steps without an estimate (journals written before this field existed).
 */
export const RATIO_MIN = 0.5;
export const RATIO_MAX = 3;

export function tokenRatio(estimate: number | undefined, actual: number | undefined): number | undefined {
  if (!estimate || !actual || estimate <= 0 || actual <= 0) return undefined;
  const r = actual / estimate;
  return r >= RATIO_MIN && r <= RATIO_MAX ? Math.round(r * 1000) / 1000 : undefined;
}

/** The ratio of the newest step in `events` (model.request + usage.recorded of the same stepId) that has one. */
export function ratioFromEvents(events: SintyEvent[]): number | undefined {
  const est = new Map<string, number>();
  let ratio: number | undefined;
  for (const e of events) {
    if (e.type === "model.request" && e.stepId) {
      const v = (e.data as { estTokens?: number }).estTokens;
      if (v) est.set(e.stepId, v);
    } else if (e.type === "usage.recorded" && e.stepId) {
      const r = tokenRatio(est.get(e.stepId), (e.data as { inputTokens?: number }).inputTokens);
      if (r) ratio = r;
    }
  }
  return ratio;
}
