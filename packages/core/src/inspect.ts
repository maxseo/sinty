import type { ChatMessage, ContextHookTrace, ContextPart, ContextPartKind, ContextPluginTrace, ContextSnapshot, ToolSchema } from "@sinty/sdk";
import { estimateTokens } from "./memory.js";

/**
 * Context snapshots for inspector plugins (docs/spec/context-inspect.md).
 *
 * The agent creates a ContextTrace only when PluginHost.inspectors() is not empty; every collector below is behind
 * that check, so a default install builds nothing and pays nothing.
 */

type Label = Omit<ContextPart, "index" | "tokens" | "role">;

/** What memory contributed; filled by MemoryRouter.contextMessages when it is given a trace. */
export interface MemoryTrace {
  facts: ContextSnapshot["memory"]["facts"];
  summary?: ContextSnapshot["memory"]["summary"];
  recall?: ContextSnapshot["memory"]["recall"];
  hooks: ContextHookTrace[];
  /** Final memory blocks, in the order of the messages contextMessages returned. */
  blocks: { id: string; source: string; untrusted?: boolean }[];
}

export interface ContextTrace {
  memory: MemoryTrace;
  /** Labels of the messages before plugin context contributors ran (same order as `base`). */
  labels: Label[];
  base: ChatMessage[];
  contexts: ContextPluginTrace[];
  /** Messages each contributor added, as JSON keys, to label them in the final list. */
  added: { label: Label; keys: Set<string> }[];
}

/** Snapshots built in this process; tests use it to prove nothing is built without an inspector. */
export const inspectStats = { built: 0 };

export function newTrace(): ContextTrace {
  return { memory: { facts: [], hooks: [], blocks: [] }, labels: [], base: [], contexts: [], added: [] };
}

const CUT = 4000;
const key = (m: ChatMessage): string => JSON.stringify(m);
const tok = (m: ChatMessage): number => estimateTokens([m]);

/** Whole-message multiset difference: what `after` has that `before` lacks and the other way round. */
export function diffMessages(before: ChatMessage[], after: ChatMessage[]): { added: ContextPluginTrace["added"]; removed: ContextPluginTrace["removed"] } {
  const count = (xs: ChatMessage[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
    return m;
  };
  const pick = (xs: ChatMessage[], other: Map<string, number>): { index: number; role: ChatMessage["role"]; content: string }[] => {
    const left = new Map(other);
    const out: { index: number; role: ChatMessage["role"]; content: string }[] = [];
    xs.forEach((x, index) => {
      const n = left.get(key(x)) ?? 0;
      if (n > 0) left.set(key(x), n - 1);
      else out.push({ index, role: x.role, content: typeof x.content === "string" ? x.content.slice(0, CUT) : "" });
    });
    return out;
  };
  return { added: pick(after, count(before)), removed: pick(before, count(after)) };
}

/** Records one context contributor run. */
export function traceContributor(trace: ContextTrace, plugin: string, name: string, before: ChatMessage[], after: ChatMessage[], ms: number, error?: string): void {
  const { added, removed } = error ? { added: [], removed: [] } : diffMessages(before, after);
  trace.contexts.push({ plugin, name, ms, ok: !error, ...(error ? { error } : {}), tokensBefore: estimateTokens(before), tokensAfter: estimateTokens(error ? before : after), added, removed });
  if (!error && added.length) trace.added.push({ label: { kind: "plugin", source: plugin, id: `${plugin}/${name}`, untrusted: true }, keys: new Set(added.map((a) => key(after[a.index]!))) });
}

/** Labels the messages built before plugin contributors: system, skills, memory blocks, dialogue. */
export function traceBase(trace: ContextTrace, messages: ChatMessage[], memoryCount: number): void {
  trace.base = messages;
  trace.labels = messages.map((m, i): Label => {
    if (i === 0) return { kind: "system", source: "core", id: "system" };
    if (i === 1) return { kind: "skills", source: "core", id: "skills" };
    if (i < 2 + memoryCount) {
      const b = trace.memory.blocks[i - 2];
      const id = b?.id ?? "memory";
      // Router blocks: memory.profile, memory.summary, memory.recalled(.external). Anything else, or a router block a
      // beforeContext processor rewrote (source = that plugin), is the processor's.
      const own = b ? b.source === "builtin:sqlite" || b.source === "plugins" : true;
      const kind: ContextPartKind = !own ? "processor" : id === "memory.summary" ? "summary" : id.startsWith("memory.recalled") ? "recall" : "memory";
      return { kind, source: b?.source ?? "builtin:sqlite", id, ...(m.untrusted ? { untrusted: true } : {}) };
    }
    return { kind: "dialogue", source: "journal", ...(m.untrusted ? { untrusted: true } : {}) };
  });
}

/** Secret-looking strings; known secret values are handled by the SecretStore. */
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|rk|pk)-(?:[A-Za-z0-9]+-)*[A-Za-z0-9_]{20,}\b/g,
  /\bsnt_[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g,
];

export function redactPatterns(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, (_m, bearer?: unknown) => (typeof bearer === "string" && bearer.startsWith("Bearer") ? `${bearer}[redacted]` : "[redacted]"));
  return out;
}

/** Deep copy with every string passed through `redact`; counts the strings that changed. */
export function redactDeep<T>(value: T, redact: (s: string) => string): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redact(v);
      if (r !== v) count++;
      return r;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  return { value: walk(value) as T, count };
}

export interface SnapshotInput {
  sessionId: string;
  turnId: string;
  stepId: string;
  step: number;
  agentId: string;
  route?: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
}

/** The snapshot for one model step; `messages` is the exact list given to the provider, then redacted. */
export function buildSnapshot(trace: ContextTrace, input: SnapshotInput, redact: (s: string) => string): ContextSnapshot {
  inspectStats.built++;
  const queues = new Map<string, Label[]>();
  trace.base.forEach((m, i) => {
    const q = queues.get(key(m)) ?? [];
    q.push(trace.labels[i]!);
    queues.set(key(m), q);
  });
  const parts: ContextPart[] = input.messages.map((m, index) => {
    const k = key(m);
    const own = queues.get(k)?.shift();
    const label = own ?? [...trace.added].reverse().find((a) => a.keys.has(k))?.label ?? { kind: "plugin", source: "unknown", untrusted: true };
    return { index, ...label, role: m.role, tokens: tok(m) };
  });
  const byKind: Partial<Record<ContextPartKind, number>> = {};
  for (const p of parts) byKind[p.kind] = (byKind[p.kind] ?? 0) + p.tokens;
  const tools = input.tools.map((t) => ({ name: t.name, tokens: Math.ceil(JSON.stringify(t).length / 4) }));
  const messagesTokens = estimateTokens(input.messages);
  const toolTokens = tools.reduce((s, t) => s + t.tokens, 0);
  const raw: ContextSnapshot = {
    version: 1,
    id: input.stepId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    stepId: input.stepId,
    step: input.step,
    at: new Date().toISOString(),
    agentId: input.agentId,
    ...(input.route ? { route: input.route } : {}),
    messages: input.messages,
    parts,
    tools,
    tokens: { total: messagesTokens + toolTokens, messages: messagesTokens, tools: toolTokens, byKind },
    memory: {
      facts: trace.memory.facts,
      ...(trace.memory.summary ? { summary: trace.memory.summary } : {}),
      ...(trace.memory.recall ? { recall: trace.memory.recall } : {}),
      hooks: trace.memory.hooks,
    },
    contexts: trace.contexts,
    redactions: 0,
  };
  // Inline images are replaced by their size: they are not text the inspector can show, and can be megabytes per step.
  raw.messages = input.messages.map((m) => (m.images?.length ? { ...m, images: m.images.map((im) => ({ mime: im.mime, data: `[${im.data.length} base64 chars omitted]` })) } : m));
  const { value, count } = redactDeep(raw, redact);
  value.redactions = count;
  return value;
}
