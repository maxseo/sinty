import type { SintyEvent } from "@sinty/sdk";
import type { UsageCall } from "./types.js";

/** What one journal event changes in the index. The fold itself stays in memory between events. */
export type FoldEffect =
  | { type: "call"; call: UsageCall }
  | { type: "agent"; sessionId: string; turnId: string; agentId: string; agentName: string }
  | { type: "title"; sessionId: string; title: string }
  | { type: "duration"; id: string; durationMs: number }
  | { type: "stop"; id: string; stopReason: string };

interface OpenStep {
  ts: string;
  route: string;
  provider: string;
  model: string;
  stopReason: string;
}

interface PluginTiming {
  model: string;
  input: number;
  output: number;
  ms: number;
  at: number;
}

interface RecentCall {
  id: string;
  model: string;
  input: number;
  output: number;
  at: number;
  durationMs: number | null;
}

export interface Fold {
  title: string;
  task: boolean;
  agents: Map<string, { id: string; name: string }>;
  steps: Map<string, OpenStep>;
  /** usage event id written for a step, so a late stop reason can find the row. */
  callByStep: Map<string, string>;
  recent: RecentCall[];
  pluginMs?: PluginTiming;
}

export interface FoldHint {
  title?: string;
  task?: boolean;
}

const TYPES = new Set(["session.created", "session.updated", "message.agent", "model.request", "model.response", "models.called", "usage.recorded"]);

export function createFold(hint: FoldHint = {}): Fold {
  return {
    title: hint.title ?? "",
    task: hint.task === true,
    agents: new Map(),
    steps: new Map(),
    callByStep: new Map(),
    recent: [],
  };
}

export function isUsageEvent(type: string): boolean {
  return TYPES.has(type);
}

function text(data: object, key: string): string {
  const v = (data as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

function whole(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

function optionalWhole(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

function money(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function elapsed(start: string, end: string): number | null {
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return b - a;
}

/**
 * Fold one journal event into index effects. Events of a session must be applied in `seq` order for
 * durations and stop reasons; a later pass fills gaps through the upsert in the store.
 */
export function applyJournalEvent(fold: Fold, event: SintyEvent): FoldEffect[] {
  if (!isUsageEvent(event.type)) return [];
  if (event.type === "session.created" || event.type === "session.updated") {
    const title = text(event.data, "title");
    if (!title) return [];
    fold.title = title;
    return [{ type: "title", sessionId: event.sessionId, title }];
  }
  if (event.type === "message.agent") {
    const agentId = text(event.data, "agentId");
    const agentName = text(event.data, "agentName");
    if (!event.turnId || (!agentId && !agentName)) return [];
    fold.agents.set(event.turnId, { id: agentId, name: agentName || agentId });
    return [{ type: "agent", sessionId: event.sessionId, turnId: event.turnId, agentId, agentName: agentName || agentId }];
  }
  if (event.type === "model.request") {
    const data = (event as SintyEvent<"model.request">).data;
    const step = event.stepId || event.id;
    const prev = fold.steps.get(step);
    fold.steps.set(step, {
      ts: event.ts,
      route: data.route,
      provider: data.provider,
      model: data.model,
      stopReason: prev?.stopReason ?? "",
    });
    return [];
  }
  if (event.type === "model.response") {
    const data = (event as SintyEvent<"model.response">).data;
    const step = event.stepId || event.id;
    const prev = fold.steps.get(step);
    const stopReason = data.stopReason || "";
    fold.steps.set(step, {
      ts: prev?.ts ?? event.ts,
      route: prev?.route ?? "",
      provider: prev?.provider ?? data.usage.provider,
      model: prev?.model ?? data.usage.model,
      stopReason,
    });
    const id = fold.callByStep.get(step);
    return id && stopReason ? [{ type: "stop", id, stopReason }] : [];
  }
  if (event.type === "models.called") {
    const data = (event as SintyEvent<"models.called">).data;
    if (!data.ok) return [];
    const at = Date.parse(event.ts);
    fold.pluginMs = { model: data.model, input: data.inputTokens, output: data.outputTokens, ms: data.ms, at };
    const hit = fold.recent.find((c) => c.durationMs == null && c.model === data.model && c.input === data.inputTokens && c.output === data.outputTokens && Number.isFinite(at) && Math.abs(c.at - at) < 15_000);
    if (!hit) return [];
    hit.durationMs = data.ms;
    return [{ type: "duration", id: hit.id, durationMs: data.ms }];
  }
  if (event.type !== "usage.recorded") return [];
  const usage = (event as SintyEvent<"usage.recorded">).data;
  const step = event.stepId || event.id;
  const open = fold.steps.get(step);
  const plugin = event.actor.kind === "plugin";
  const speaker = event.turnId ? fold.agents.get(event.turnId) : undefined;
  let durationMs = open ? elapsed(open.ts, event.ts) : null;
  const timing = fold.pluginMs;
  if (durationMs == null && timing && timing.model === usage.model && timing.input === usage.inputTokens && timing.output === usage.outputTokens && Number.isFinite(timing.at) && Math.abs(timing.at - Date.parse(event.ts)) < 15_000) {
    durationMs = timing.ms;
  }
  const call: UsageCall = {
    id: event.id,
    ts: event.ts,
    seq: event.seq,
    sessionId: event.sessionId,
    turnId: event.turnId ?? "",
    stepId: event.stepId ?? "",
    sessionTitle: fold.title,
    sessionKind: fold.task ? "task" : "chat",
    agentId: plugin ? event.actor.id : speaker?.id ?? "",
    agentName: plugin ? event.actor.id : speaker?.name ?? "",
    provider: usage.provider || open?.provider || "",
    model: usage.model || open?.model || "",
    route: open?.route ?? "",
    inputTokens: whole(usage.inputTokens),
    outputTokens: whole(usage.outputTokens),
    cachedTokens: optionalWhole(usage.cachedTokens),
    cacheMissTokens: optionalWhole(usage.cacheMissTokens),
    cacheWriteTokens: optionalWhole(usage.cacheWriteTokens),
    costUsd: money(usage.costUsd),
    stopReason: open?.stopReason ?? "",
    durationMs,
    source: plugin ? "plugin" : "chat",
    plugin: plugin ? event.actor.id : "",
  };
  fold.callByStep.set(step, call.id);
  fold.recent.push({ id: call.id, model: call.model, input: call.inputTokens, output: call.outputTokens, at: Date.parse(call.ts), durationMs: call.durationMs });
  if (fold.recent.length > 30) fold.recent.splice(0, fold.recent.length - 30);
  return [{ type: "call", call }];
}
