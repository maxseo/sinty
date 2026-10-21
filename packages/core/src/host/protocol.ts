import type { ChatMessage, ContextInput, ContextSnapshot, EventType, LiveEvent, PluginManifest, ProviderChunk, ProviderRequest, SintyEvent, SystemSectionInput, ToolSideEffects } from "@sinty/sdk";

export interface RouteInfo {
  method: string;
  path: string;
  public: boolean;
}

export interface SectionInfo {
  name: string;
  order: number;
  kind: "system" | "skills";
}

export interface WireHttpRequest {
  route: number;
  params: Record<string, string>;
  method: string;
  /** Path relative to the plugin mount, with the query string. */
  url: string;
  headers: [string, string][];
  body: Uint8Array | null;
}

export type AgentOp = "listSessions" | "getSession" | "events" | "createSession" | "send" | "interrupt";

export interface InitMessage {
  t: "init";
  manifest: PluginManifest;
  entry: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  /** A host must match both lists. */
  net: { manifest: string[]; policy: string[] };
  paths: { workspace: string; skills: string; plugin: string; data: string };
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

/** ctx.net.public.fetch over IPC; the core does the request (see netguard.ts). */
export interface NetPublicInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  truncate?: boolean;
}

export type NetPublicResult =
  | { url: string; status: number; statusText: string; headers: [string, string][]; body: Uint8Array; redirects: string[]; truncated: boolean }
  | { server: string; username: string; password: string }
  | { ok: true };

export type ProviderWireRequest = Omit<ProviderRequest, "signal">;

export type ToChild =
  | InitMessage
  | { t: "tool.run"; id: number; name: string; args: unknown; ctx: CallCtx }
  | { t: "tool.recover"; id: number; name: string; ctx: CallCtx }
  | { t: "provider.stream"; id: number; protocol: string; req: ProviderWireRequest }
  | { t: "context.run"; id: number; name: string; input: ContextInput }
  | { t: "section.run"; id: number; name: string; input: SystemSectionInput }
  | { t: "cancel"; id: number }
  | { t: "event"; event: SintyEvent }
  | { t: "journal.events"; id: number; events: SintyEvent[] }
  | ({ t: "http.request"; id: number } & WireHttpRequest)
  | { t: "agent.result"; id: number; ok: true; value: unknown }
  | { t: "agent.result"; id: number; ok: false; error: WireError }
  | { t: "agent.event"; id: number; event: LiveEvent }
  | { t: "agent.end"; id: number; error?: WireError }
  | { t: "provider.embed"; id: number; protocol: string; req: { endpoint: ProviderRequest["endpoint"]; model: string; input: string[] } }
  | { t: "provider.list"; id: number; protocol: string; endpoint: ProviderRequest["endpoint"] }
  | { t: "models.result"; id: number; ok: true; value: unknown }
  | { t: "models.result"; id: number; ok: false; error: WireError }
  | { t: "memory.call"; id: number; kind: "provider" | "processor"; name: string; method: string; args: unknown[] }
  | { t: "context.snapshot"; snapshot: ContextSnapshot }
  | { t: "net.result"; id: number; ok: true; value: NetPublicResult }
  | { t: "net.result"; id: number; ok: false; error: WireError }
  | { t: "shutdown" };

export type FromChild =
  | {
      t: "ready";
      tools: ToolInfo[];
      providers: string[];
      contexts: { name: string; order: number }[];
      /** ctx.systemSection blocks; absent from plugins built against an older SDK. */
      sections?: SectionInfo[];
      subscriptions: (EventType | "*")[];
      routes: RouteInfo[];
      /** Provider protocols that implement embed(). */
      embedders?: string[];
      /** Provider protocols that implement listModels(). */
      listers?: string[];
      memory?: { providers: string[]; processors: { name: string; order: number; hooks: string[] }[] };
      /** The plugin registered ctx.onContextSnapshot. */
      inspects?: boolean;
    }
  | { t: "provider.embedded"; id: number; ok: true; value: { vectors: number[][]; usage?: { inputTokens: number } } }
  | { t: "provider.embedded"; id: number; ok: false; error: WireError }
  | { t: "provider.listed"; id: number; ok: true; value: { id: string; contextWindow?: number; maxOutputTokens?: number }[] }
  | { t: "provider.listed"; id: number; ok: false; error: WireError }
  | { t: "models.call"; id: number; op: "complete" | "embed"; req: Record<string, unknown> }
  | { t: "net.public"; id: number; op: "fetch"; url: string; init: NetPublicInit }
  | { t: "net.public"; id: number; op: "proxy" }
  | { t: "net.public"; id: number; op: "check"; url: string }
  | { t: "memory.result"; id: number; ok: true; value: unknown }
  | { t: "memory.result"; id: number; ok: false; error: WireError }
  | { t: "http.start"; id: number; status: number; headers: [string, string][] }
  | { t: "http.chunk"; id: number; chunk: Uint8Array }
  | { t: "http.end"; id: number }
  | { t: "http.error"; id: number; error: WireError }
  | { t: "agent.call"; id: number; op: AgentOp; args: unknown[] }
  | { t: "agent.stream"; id: number; sessionId: string; afterSeq: number }
  | { t: "agent.stream.close"; id: number }
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
  | { t: "section.result"; id: number; text: string | null }
  | { t: "section.error"; id: number; error: WireError }
  | { t: "journal.read"; id: number; sessionId: string; afterSeq?: number; types?: EventType[] }
  | { t: "log"; level: "debug" | "info" | "warn" | "error"; msg: string; data?: unknown };
