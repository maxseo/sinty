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
  cachedTokens?: number;
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

  "model.request": { route: string; provider: string; model: string; messagesHash: string };
  "model.delta": { text?: string; reasoning?: string };
  "model.response": { text?: string; toolCalls: ToolCallRef[]; stopReason: string; usage: Usage };
  "model.fallback": { from: string; to: string; reason: string };

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

  "plugin.loaded": { plugin: string; version: string; commit?: string };
  "plugin.crashed": { plugin: string; exitCode: number | null; restarts: number };
  "plugin.patch.proposed": { patchId: string; plugin: string; reason: string; branch: string };
  "plugin.patch.tested": { patchId: string; ok: boolean; output: string };
  "plugin.patch.applied": { patchId: string; commit: string };
  "plugin.patch.rolled_back": { patchId: string; toCommit: string; reason: string };

  "memory.written": { id: string; action: "inserted" | "updated" | "dropped"; tier: string; scope: string; source: string; provider: string };

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
