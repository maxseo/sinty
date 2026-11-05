/** One model call kept in the plugin index. Null means the provider did not report that field. */
export interface UsageCall {
  id: string;
  ts: string;
  seq: number;
  sessionId: string;
  turnId: string;
  stepId: string;
  sessionTitle: string;
  sessionKind: "chat" | "task";
  agentId: string;
  agentName: string;
  provider: string;
  model: string;
  route: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number | null;
  cacheMissTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  stopReason: string;
  durationMs: number | null;
  source: "chat" | "plugin";
  plugin: string;
}

export interface UsageFilter {
  from?: string;
  to?: string;
  model?: string;
  provider?: string;
  agent?: string;
  session?: string;
}

export type Bucket = "hour" | "day" | "week";

export interface TokenParts {
  hit: number;
  miss: number;
  plain: number;
  output: number;
}

export interface SeriesPoint {
  t: string;
  label: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  hit: number;
  miss: number;
  plain: number;
  costUsd: number | null;
}

export interface ModelSeries {
  model: string;
  values: number[];
}

export interface Series {
  bucket: Bucket;
  hasCache: boolean;
  hasCost: boolean;
  /** The chart keeps the newest buckets when the span is long. */
  chartTruncated: boolean;
  points: SeriesPoint[];
  models: ModelSeries[];
}

export interface Summary {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheMissTokens: number;
  cacheWriteTokens: number;
  hasCache: boolean;
  hasCost: boolean;
  costUsd: number | null;
  pricedCalls: number;
}

export interface TaskRow {
  sessionId: string;
  title: string;
  sessionKind: "chat" | "task";
  agentId: string;
  agentName: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
  firstTs: string;
  lastTs: string;
}

export interface Facets {
  models: string[];
  providers: string[];
  agents: { id: string; name: string }[];
}
