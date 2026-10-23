/** Frozen in M6. New fields may be added; renaming or removing a field needs a new major version. */
export const PROTOCOL_VERSION = "sinty/1.0" as const;

export type ActorKind = "human" | "agent" | "supervisor" | "system" | "plugin";

export interface Actor {
  kind: ActorKind;
  id: string;
}

export type AgentState = "idle" | "working" | "blocked" | "done" | "error";

export type ToolSideEffects = "none" | "read" | "write" | "external";

export interface Usage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens read from the provider's cache (hit). */
  cachedTokens?: number;
  /** Prompt tokens not read from the cache (miss), when the provider reports it. */
  cacheMissTokens?: number;
  /** Prompt tokens written to the cache on this call (Anthropic cache_creation, OpenAI cache_write). */
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface BlobRef {
  blob: `sha256:${string}`;
  mime: string;
  bytes: number;
  name?: string;
}

export interface EventDataMap {
  "session.created": { title?: string; projectId?: string; metadata?: Record<string, unknown> };
  "session.updated": { title?: string; metadata?: Record<string, unknown> };
  "session.archived": Record<string, never>;

  "turn.started": { trigger: "message" | "schedule" | "task" | "resume" };
  "turn.completed": { steps: number };
  "turn.failed": { code: string; message: string };
  "turn.interrupted": { by: Actor };
  "turn.blocked": { reason: "approval" | "ask_human" | "supervisor" | "budget"; detail?: string };
  "turn.resumed": { fromSeq: number };

  "message.user": { text: string; attachments?: BlobRef[]; channel?: string };
  "message.agent": { text: string; attachments?: BlobRef[] };
  "message.channel": { channel: string; direction: "in" | "out"; externalId?: string; text: string };

  /** `estTokens`: the core's chars/4 estimate of this prompt (messages + tool schemas), compared with usage.inputTokens. */
  /** `trimmedForWindow`: a fallback route with a smaller window got this request with old tool results cut. */
  "model.request": { route: string; provider: string; model: string; messagesHash: string; estTokens?: number; trimmedForWindow?: boolean };
  "model.delta": { text?: string; reasoning?: string };
  "model.response": { text?: string; toolCalls: ToolCallRef[]; stopReason: string; usage: Usage };
  /**
   * The next route is tried. `reason` is the error of `from`, or `window_too_small` when `from` (a fallback) was
   * skipped because the prompt (`need` tokens, real-usage scaled) does not fit its `window` even with old tool
   * results trimmed.
   */
  "model.fallback": { from: string; to: string; reason: string; window?: number; need?: number };

  "tool.call.requested": ToolCallRef;
  "tool.call.approval_requested": { callId: string; tool: string; args: unknown; reason: string };
  "tool.call.approved": { callId: string; by: Actor; note?: string };
  "tool.call.denied": { callId: string; by: Actor; note?: string };
  "tool.call.started": { callId: string; tool: string; idempotencyKey: string };
  "tool.call.progress": { callId: string; message?: string; ratio?: number };
  "tool.call.completed": { callId: string; result: unknown; blobs?: BlobRef[]; durationMs: number };
  "tool.call.failed": { callId: string; code: string; message: string; hint?: string; durationMs: number };

  "supervisor.notice": { detector: string; level: 1 | 2 | 3; text: string; refs?: string[] };
  "supervisor.escalated": { detector: string; reason: string };
  "supervisor.incident_resolved": { incidentId: string; tool?: string; code?: string; fixSummary: string };

  "agent.state": { state: AgentState };

  /** A background agent.task finished; written on the parent session (often without an active turn). */
  "task.completed": { taskId: string; childSessionId: string; status: "completed" | "failed" | "interrupted"; text: string };


  "plugin.loaded": { plugin: string; version: string; commit?: string };
  "plugin.crashed": { plugin: string; exitCode: number | null; restarts: number };
  "plugin.patch.proposed": { patchId: string; plugin: string; reason: string; branch: string };
  "plugin.patch.tested": { patchId: string; ok: boolean; output: string };
  "plugin.patch.applied": { patchId: string; commit: string };
  "plugin.patch.rolled_back": { patchId: string; toCommit: string; reason: string };

  "memory.written": { id: string; action: "inserted" | "updated" | "dropped"; tier: string; scope: string; source: string; provider: string; by?: string };
  /** Automatic recall for one turn; the router reuses it for every later step of the same turn. */
  "memory.recalled": { queries: string[]; providers: string[]; records: { id: string; provider: string; text: string; ref?: string; untrusted?: boolean; createdAt?: string }[]; tokens: number; ms: number; arm?: string; shadow?: boolean };
  /**
   * The session memory snapshot: the memory profile block as the prompt shows it from now on. Written on the first
   * model step of a session, after each compaction and when another agent starts speaking; the prompt reuses it
   * unchanged in between. Facts saved later reach the model through turn contexts (`memory.updates`).
   */
  "memory.snapshot": { text: string; factIds: string[]; reason: "start" | "compaction" | "agent"; agentId: string };
  "memory.compacted": { coversUntil: number; summaryTokens: number; facts: number; by: string; ok: boolean; reason?: string };
  /** A memory plugin failed or timed out; the router fell back to the builtin store. */
  "memory.degraded": { provider: string; hook?: string; reason: string };
  /** Which experiment arm a session belongs to (once per turn when memory.experiments is set). */
  "memory.experiment": { experiment: string; arm: string; shadow?: string[] };
  /** A plugin called a model through ctx.models. */
  "models.called": { plugin: string; op: "complete" | "embed"; route: string; provider: string; model: string; inputTokens: number; outputTokens: number; ms: number; ok: boolean; error?: string };

  /**
   * The turn context: written once, on the first model step of a turn, and shown to the model as a message right
   * before that turn's first user message on every later step and turn, unchanged (time of the turn, recall, memory
   * updates). `blocks` names its parts; `factIds` are the memory facts it announced.
   */
  "context.turn": { text: string; at: string; timezone: string; blocks: { id: string; source: string; untrusted?: boolean }[]; factIds: string[]; untrusted?: boolean };

  "usage.recorded": Usage;
  "checkpoint": { state: unknown };
}

export type EventType = keyof EventDataMap;

/** Event types delivered to live streams but never written to the journal. */
export const STREAM_ONLY_EVENTS = ["model.delta", "tool.call.progress"] as const satisfies readonly EventType[];

/** A live-only event: delivered to streams, never journaled. */
export type StreamEvent =
  | { type: "model.delta"; sessionId: string; turnId: string; ts: string; data: EventDataMap["model.delta"] }
  | { type: "tool.call.progress"; sessionId: string; turnId: string; ts: string; data: EventDataMap["tool.call.progress"] };

/** What a live stream yields: journaled events (with `seq`) and stream-only events (without). */
export type LiveEvent = SintyEvent | StreamEvent;

export interface ToolCallRef {
  callId: string;
  tool: string;
  args: unknown;
}

export interface SintyEvent<T extends EventType = EventType> {
  id: string;
  seq: number;
  ts: string;
  sessionId: string;
  turnId?: string;
  stepId?: string;
  type: T;
  actor: Actor;
  causationId?: string;
  data: EventDataMap[T];
}
