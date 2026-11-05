import type { Bucket, Facets, ModelSeries, Series, SeriesPoint, Summary, TaskRow, TokenParts, UsageCall, UsageFilter } from "./types.js";

const MAX_BUCKETS = 96;
const TOP_MODELS = 5;

export function tokenParts(call: Pick<UsageCall, "inputTokens" | "outputTokens" | "cachedTokens" | "cacheMissTokens">): TokenParts {
  const output = call.outputTokens;
  if (call.cachedTokens == null && call.cacheMissTokens == null) return { hit: 0, miss: 0, plain: call.inputTokens, output };
  const hit = Math.max(0, call.cachedTokens ?? 0);
  if (call.cacheMissTokens == null) return { hit, miss: Math.max(0, call.inputTokens - hit), plain: 0, output };
  const miss = Math.max(0, call.cacheMissTokens);
  return { hit, miss, plain: Math.max(0, call.inputTokens - hit - miss), output };
}

export function matches(call: UsageCall, filter: UsageFilter): boolean {
  if (filter.from && call.ts < filter.from) return false;
  if (filter.to && call.ts >= filter.to) return false;
  if (filter.model && call.model !== filter.model) return false;
  if (filter.provider && call.provider !== filter.provider) return false;
  if (filter.agent && call.agentId !== filter.agent && call.agentName !== filter.agent) return false;
  if (filter.session && call.sessionId !== filter.session) return false;
  return true;
}

export function summarize(calls: readonly UsageCall[]): Summary {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let cacheMissTokens = 0;
  let cacheWriteTokens = 0;
  let hasCache = false;
  let cost = 0;
  let pricedCalls = 0;
  for (const c of calls) {
    inputTokens += c.inputTokens;
    outputTokens += c.outputTokens;
    if (c.cachedTokens != null || c.cacheMissTokens != null) hasCache = true;
    cachedTokens += c.cachedTokens ?? 0;
    cacheMissTokens += c.cacheMissTokens ?? 0;
    cacheWriteTokens += c.cacheWriteTokens ?? 0;
    if (c.costUsd != null) {
      cost += c.costUsd;
      pricedCalls += 1;
    }
  }
  return {
    requests: calls.length,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedTokens,
    cacheMissTokens,
    cacheWriteTokens,
    hasCache,
    hasCost: pricedCalls > 0,
    costUsd: pricedCalls > 0 ? cost : null,
    pricedCalls,
  };
}

/** Minutes east of UTC is negative in `Date#getTimezoneOffset` (Moscow is -180). */
export function clampOffset(minutes: number): number {
  if (!Number.isFinite(minutes)) return 0;
  return Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(minutes)));
}

function shifted(ts: string, offsetMin: number): Date | undefined {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t - offsetMin * 60_000);
}

export function bucketKey(ts: string, bucket: Bucket, offsetMin: number): string | undefined {
  const local = shifted(ts, offsetMin);
  if (!local) return undefined;
  if (bucket === "hour") return local.toISOString().slice(0, 13);
  if (bucket === "day") return local.toISOString().slice(0, 10);
  const day = local.getUTCDay();
  const delta = day === 0 ? 6 : day - 1;
  const monday = new Date(local);
  monday.setUTCDate(local.getUTCDate() - delta);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().slice(0, 10);
}

export function bucketLabel(key: string, bucket: Bucket): string {
  if (bucket === "hour") return `${key.slice(11, 13)}:00`;
  const [, m, d] = key.split("-");
  return `${d}.${m}`;
}

export function chooseBucket(spanMs: number): Bucket {
  if (!Number.isFinite(spanMs) || spanMs <= 36 * 3_600_000) return "hour";
  if (spanMs <= 120 * 86_400_000) return "day";
  return "week";
}

function spanOf(calls: readonly UsageCall[], filter: UsageFilter, now: number): number {
  const start = filter.from ? Date.parse(filter.from) : calls.length ? Date.parse(calls[0]!.ts) : now;
  const end = filter.to ? Date.parse(filter.to) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function stepKey(key: string, bucket: Bucket): string | undefined {
  if (bucket === "hour") {
    const t = Date.parse(`${key}:00:00.000Z`);
    if (!Number.isFinite(t)) return undefined;
    return new Date(t + 3_600_000).toISOString().slice(0, 13);
  }
  const t = Date.parse(`${key}T00:00:00.000Z`);
  if (!Number.isFinite(t)) return undefined;
  const d = new Date(t);
  d.setUTCDate(d.getUTCDate() + (bucket === "week" ? 7 : 1));
  return d.toISOString().slice(0, 10);
}

function fillKeys(keys: string[], bucket: Bucket): { keys: string[]; truncated: boolean } {
  if (keys.length === 0) return { keys, truncated: false };
  const sorted = [...keys].sort();
  const out: string[] = [];
  let cursor = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const guard = MAX_BUCKETS + sorted.length + 2;
  for (let i = 0; i < guard && cursor <= last; i++) {
    out.push(cursor);
    const next = stepKey(cursor, bucket);
    if (!next || next === cursor) break;
    cursor = next;
  }
  if (out.length > MAX_BUCKETS) return { keys: out.slice(-MAX_BUCKETS), truncated: true };
  return { keys: out, truncated: false };
}

interface Acc {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  hit: number;
  miss: number;
  plain: number;
  cost: number;
  priced: number;
  byModel: Map<string, number>;
}

function emptyAcc(): Acc {
  return { requests: 0, inputTokens: 0, outputTokens: 0, hit: 0, miss: 0, plain: 0, cost: 0, priced: 0, byModel: new Map() };
}

export function seriesOf(calls: readonly UsageCall[], filter: UsageFilter, offsetMin: number, now = Date.now()): Series {
  const bucket = chooseBucket(spanOf(calls, filter, now));
  const groups = new Map<string, Acc>();
  let hasCache = false;
  let hasCost = false;
  for (const c of calls) {
    const key = bucketKey(c.ts, bucket, offsetMin);
    if (!key) continue;
    const acc = groups.get(key) ?? emptyAcc();
    const parts = tokenParts(c);
    acc.requests += 1;
    acc.inputTokens += c.inputTokens;
    acc.outputTokens += c.outputTokens;
    acc.hit += parts.hit;
    acc.miss += parts.miss;
    acc.plain += parts.plain;
    if (c.cachedTokens != null || c.cacheMissTokens != null) hasCache = true;
    if (c.costUsd != null) {
      acc.cost += c.costUsd;
      acc.priced += 1;
      hasCost = true;
    }
    const model = c.model || "—";
    acc.byModel.set(model, (acc.byModel.get(model) ?? 0) + c.inputTokens + c.outputTokens);
    groups.set(key, acc);
  }
  const filled = fillKeys([...groups.keys()], bucket);
  const totals = new Map<string, number>();
  for (const key of filled.keys) {
    const acc = groups.get(key);
    if (!acc) continue;
    for (const [model, n] of acc.byModel) totals.set(model, (totals.get(model) ?? 0) + n);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked.slice(0, TOP_MODELS).map(([model]) => model);
  const rest = ranked.length > TOP_MODELS;
  const models: ModelSeries[] = top.map((model) => ({ model, values: [] }));
  if (rest) models.push({ model: "другие", values: [] });
  const points: SeriesPoint[] = [];
  for (const key of filled.keys) {
    const acc = groups.get(key) ?? emptyAcc();
    points.push({
      t: key,
      label: bucketLabel(key, bucket),
      requests: acc.requests,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      totalTokens: acc.inputTokens + acc.outputTokens,
      hit: acc.hit,
      miss: acc.miss,
      plain: acc.plain,
      costUsd: acc.priced > 0 ? acc.cost : null,
    });
    const seen = new Set(top);
    let other = 0;
    for (const [model, n] of acc.byModel) {
      if (seen.has(model)) models.find((m) => m.model === model)?.values.push(n);
      else other += n;
    }
    for (const m of models) {
      if (m.values.length < points.length) m.values.push(m.model === "другие" ? other : 0);
    }
  }
  return { bucket, hasCache, hasCost, chartTruncated: filled.truncated, points, models };
}

export function tasksOf(calls: readonly UsageCall[]): TaskRow[] {
  const map = new Map<string, TaskRow>();
  for (const c of calls) {
    const cur = map.get(c.sessionId);
    if (!cur) {
      map.set(c.sessionId, {
        sessionId: c.sessionId,
        title: c.sessionTitle,
        sessionKind: c.sessionKind,
        agentId: c.agentId,
        agentName: c.agentName,
        requests: 1,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        totalTokens: c.inputTokens + c.outputTokens,
        costUsd: c.costUsd,
        firstTs: c.ts,
        lastTs: c.ts,
      });
      continue;
    }
    cur.requests += 1;
    cur.inputTokens += c.inputTokens;
    cur.outputTokens += c.outputTokens;
    cur.totalTokens += c.inputTokens + c.outputTokens;
    if (c.costUsd != null) cur.costUsd = (cur.costUsd ?? 0) + c.costUsd;
    if (c.ts < cur.firstTs) cur.firstTs = c.ts;
    if (c.ts >= cur.lastTs) {
      cur.lastTs = c.ts;
      if (c.sessionTitle) cur.title = c.sessionTitle;
      if (c.agentName) {
        cur.agentName = c.agentName;
        cur.agentId = c.agentId;
      }
      cur.sessionKind = c.sessionKind;
    }
  }
  return [...map.values()].sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : a.sessionId.localeCompare(b.sessionId)));
}

export function pageOf(calls: readonly UsageCall[], offset: number, limit: number): { total: number; items: UsageCall[] } {
  const sorted = [...calls].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.seq - a.seq));
  const start = Math.max(0, offset);
  return { total: sorted.length, items: sorted.slice(start, start + Math.max(0, limit)) };
}

export function facetsOf(calls: readonly UsageCall[]): Facets {
  const models = new Set<string>();
  const providers = new Set<string>();
  const agents = new Map<string, string>();
  for (const c of calls) {
    if (c.model) models.add(c.model);
    if (c.provider) providers.add(c.provider);
    if (c.agentId || c.agentName) agents.set(c.agentId || c.agentName, c.agentName || c.agentId);
  }
  return {
    models: [...models].sort((a, b) => a.localeCompare(b)),
    providers: [...providers].sort((a, b) => a.localeCompare(b)),
    agents: [...agents.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
