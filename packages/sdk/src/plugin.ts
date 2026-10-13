import type { z } from "zod";
import type { AgentState, EventType, SintyEvent, ToolSideEffects } from "./events.js";
import type { PolicyDecision, ToolDefinition } from "./tool.js";

export type PluginKind = "provider" | "tool" | "context" | "channel" | "server" | "schedule" | "event" | "ui";

export type PluginRuntime = "node" | "mcp-stdio" | "http";

export interface PluginPermissions {
  fs?: { read?: string[]; write?: string[] };
  net?: string[];
  secrets?: string[];
  env?: string[];
  shell?: boolean;
}

export interface ManifestTool {
  name: string;
  description?: string;
  sideEffects: ToolSideEffects;
  idempotent?: boolean;
  recoverable?: boolean;
  docs?: string;
  defaultPolicy?: PolicyDecision;
}

/** Shape of `sinty.plugin.json`. Mirrors `schemas/plugin-manifest.schema.json`. */
export interface PluginManifest {
  $schema?: string;
  name: string;
  version: string;
  description: string;
  kinds: PluginKind[];
  runtime: PluginRuntime;
  entry?: string;
  command?: string[];
  url?: string;
  permissions: PluginPermissions;
  tools?: ManifestTool[];
  config?: Record<string, unknown>;
  tests?: string;
  editable?: boolean;
}

// ---- model provider ----

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
  untrusted?: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Resolved from `config.yaml` by the core; `apiKey` is a secret value and must never be logged. */
export interface ProviderEndpoint {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
}

export interface ProviderRequest {
  endpoint: ProviderEndpoint;
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  maxOutputTokens?: number;
  reasoning?: "off" | "low" | "medium" | "high";
  signal: AbortSignal;
}

export type ProviderChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "done"; stopReason: string; usage: { inputTokens: number; outputTokens: number; cachedTokens?: number } };

export interface ProviderDefinition {
  protocol: string;
  stream(req: ProviderRequest): AsyncIterable<ProviderChunk>;
  listModels?(endpoint: ProviderEndpoint): Promise<{ id: string; contextWindow?: number }[]>;
}

// ---- context ----

export interface ContextInput {
  sessionId: string;
  events: SintyEvent[];
  messages: ChatMessage[];
  budgetTokens: number;
}

/** Context plugins run in order; each receives the previous output. */
export type ContextContributor = (input: ContextInput) => Promise<ChatMessage[]>;

// ---- channels ----

export interface ChannelDefinition {
  name: string;
  start(api: { deliver(msg: { sessionKey: string; text: string; externalId?: string }): Promise<void> }): Promise<void>;
  send(msg: { sessionId: string; text: string; state?: AgentState }): Promise<void>;
  stop?(): Promise<void>;
}

// ---- setup context ----

export interface PluginContext {
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
  /** Absolute paths; the process can only write where `permissions.fs.write` allows. */
  readonly paths: { readonly workspace: string; readonly skills: string; readonly plugin: string };
  readonly log: { debug(msg: string, data?: unknown): void; info(msg: string, data?: unknown): void; warn(msg: string, data?: unknown): void; error(msg: string, data?: unknown): void };

  /** Network access limited to `permissions.net`. */
  readonly net: { fetch(input: string | URL, init?: RequestInit): Promise<Response> };
  /** Secret values by name from `permissions.secrets`; never journaled. */
  readonly secrets: { get(name: string): Promise<string> };
  /** Read-only journal access. */
  readonly journal: { read(sessionId: string, opts?: { afterSeq?: number; types?: EventType[] }): AsyncIterable<SintyEvent> };

  tool<I extends z.ZodType>(def: ToolDefinition<I>): void;
  provider(def: ProviderDefinition): void;
  context(name: string, contributor: ContextContributor, opts?: { order?: number }): void;
  channel(def: ChannelDefinition): void;
  schedule(name: string, cron: string, run: (signal: AbortSignal) => Promise<void>): void;
  on<T extends EventType>(type: T | "*", handler: (event: SintyEvent<T>) => void | Promise<void>): void;
  http(route: { method: string; path: string; handler: (req: Request) => Promise<Response> }): void;
}

export interface PluginDefinition {
  name: string;
  setup(ctx: PluginContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}
