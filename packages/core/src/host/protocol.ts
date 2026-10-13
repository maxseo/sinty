import type { ChatMessage, ContextInput, EventType, PluginManifest, ProviderChunk, ProviderRequest, SintyEvent, ToolSideEffects } from "@sinty/sdk";

export interface InitMessage {
  t: "init";
  manifest: PluginManifest;
  entry: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  /** A host must match both lists. */
  net: { manifest: string[]; policy: string[] };
  paths: { workspace: string; skills: string; plugin: string };
}

export interface ToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  sideEffects: ToolSideEffects;
  idempotent: boolean;
  recoverable: boolean;
  timeoutMs?: number;
  docs?: string;
}

export interface WireError {
  code: string;
  message: string;
  hint?: string;
  retryable?: boolean;
}

export interface CallCtx {
  sessionId: string;
  turnId: string;
  callId: string;
  idempotencyKey: string;
}

export type ProviderWireRequest = Omit<ProviderRequest, "signal">;

export type ToChild =
  | InitMessage
  | { t: "tool.run"; id: number; name: string; args: unknown; ctx: CallCtx }
  | { t: "tool.recover"; id: number; name: string; ctx: CallCtx }
  | { t: "provider.stream"; id: number; protocol: string; req: ProviderWireRequest }
  | { t: "context.run"; id: number; name: string; input: ContextInput }
  | { t: "cancel"; id: number }
  | { t: "event"; event: SintyEvent }
  | { t: "journal.events"; id: number; events: SintyEvent[] }
  | { t: "shutdown" };

export type FromChild =
  | { t: "ready"; tools: ToolInfo[]; providers: string[]; contexts: { name: string; order: number }[]; subscriptions: (EventType | "*")[] }
  | { t: "fatal"; error: WireError }
  | { t: "tool.progress"; id: number; message?: string; ratio?: number }
  | { t: "tool.result"; id: number; ok: true; content: unknown }
  | { t: "tool.result"; id: number; ok: false; error: WireError }
  | { t: "tool.recovered"; id: number; outcome: unknown }
  | { t: "provider.chunk"; id: number; chunk: ProviderChunk }
  | { t: "provider.end"; id: number }
  | { t: "provider.error"; id: number; error: WireError }
  | { t: "context.result"; id: number; messages: ChatMessage[] }
  | { t: "context.error"; id: number; error: WireError }
  | { t: "journal.read"; id: number; sessionId: string; afterSeq?: number; types?: EventType[] }
  | { t: "log"; level: "debug" | "info" | "warn" | "error"; msg: string; data?: unknown };
