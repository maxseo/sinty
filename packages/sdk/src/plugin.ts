import type { z } from "zod";
import type { AgentState, EventType, LiveEvent, SintyEvent, ToolSideEffects } from "./events.js";
import type { PolicyDecision, ToolDefinition } from "./tool.js";
import type { EmbedProviderRequest, MemoryProcessorDefinition, MemoryProviderDefinition, ModelsApi } from "./memory.js";
import type { ContextSnapshot } from "./inspect.js";
import type { SettingsSectionManifest } from "./settings.js";

export type PluginKind = "provider" | "tool" | "context" | "channel" | "server" | "schedule" | "event" | "ui" | "memory";

export type PluginRuntime = "node" | "mcp-stdio" | "http";

/** `sessions.read`: list sessions, read events, live streams. `sessions.write`: create sessions, send messages, interrupt. */
export type AgentScope = "sessions.read" | "sessions.write";

export interface PluginPermissions {
  fs?: { read?: string[]; write?: string[] };
  /**
   * Hosts `ctx.net.fetch` may reach (each must also be in policy.yaml `net.allow`). The token `"$PUBLIC"` grants
   * `ctx.net.public`: public internet through the core, which refuses private, loopback and link-local addresses.
   */
  net?: string[];
  /**
   * Launch a headless browser (Playwright Chromium). The process may start child processes and read the browser
   * install; its traffic must go through `ctx.net.public.proxy()`. Needs `"$PUBLIC"` in `net`. See docs/spec/net-public.md.
   */
  browser?: boolean;
  secrets?: string[];
  env?: string[];
  shell?: boolean;
  agent?: AgentScope[];
  /** Model routes the plugin may call through `ctx.models`: "default", "cheap", "embed", a models.routes key or "*". */
  models?: string[];
  /**
   * `inspect`: receive a ContextSnapshot for every model step (see `ctx.onContextSnapshot`). Snapshots hold the full
   * prompt, private memory included, so the core also needs the plugin in config.yaml `plugins.inspect`.
   */
  context?: "inspect"[];
}

/** A tab in the Web UI. The UI loads `path` (a GET route of this plugin) in a sandboxed iframe. */
export interface UiTab {
  /** `[a-z][a-z0-9-]*`, unique within the plugin. */
  id: string;
  title: string;
  /** Plugin HTTP route relative to `/p/<plugin>`, e.g. "/tab". It must be public (the iframe sends no token) and serve only static HTML. Exactly one of `path` and `builtin`. */
  path?: string;
  /** A page that is part of the Web UI build (`board`, `calendar`) instead of an iframe. For bundled plugins. */
  builtin?: string;
  /**
   * Where the Web UI shows the tab. `sidebar` (default): a page of its own in the left navigation.
   * `session`: a view toggle in the header of an open chat, next to "Чат" and "Журнал"; the bridge tells the page
   * which session is open (`init.sessionId`, then `{ op: "session" }` when the user switches chats).
   * `project`: a tab inside a project; the bridge tells the page `init.projectId`.
   * Every tab is an access right `ui:<plugin>/<id>` (docs/spec/plugin-rules.md).
   */
  placement?: UiTabPlacement;
}

export type UiTabPlacement = "sidebar" | "session" | "project";

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
  /**
   * `static`: files served by the core at `/ui/<name>/` (only for plugins with `editable: false`).
   * `tabs`: pages the Web UI shows in a sandboxed iframe; data reaches them only through the UI's postMessage bridge.
   */
  ui?: { static?: string; tabs?: UiTab[] };
  /** A section of the Web UI settings for this plugin's `config` (values in config.yaml `plugins.config.<name>`). */
  settings?: SettingsSectionManifest;
}

// ---- model provider ----

export type ChatRole = "system" | "user" | "assistant" | "tool";

/**
 * Prompt-cache boundary set by the core on the last message of a stability zone (docs/spec/protocol.md, "Prompt
 * caching"). Everything up to and including a marked message is byte-identical on the next call while the zone holds:
 * - `static`: tools, system prompt and skills; changes only when the persona, config, skills or tools change;
 * - `session`: the session memory snapshot and summary; changes only at compaction;
 * - `turn`: the last message of the dialogue; the next step or turn appends after it.
 * Provider plugins turn hints into their cache controls (Anthropic `cache_control`) or ignore them.
 */
export type CacheHint = "static" | "session" | "turn";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Inline images for providers that accept them. Text of other files stays in `content`. */
  images?: { mime: string; data: string }[];
  toolCallId?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
  untrusted?: boolean;
  /** Set by the core only; never part of the content a provider sends. */
  cacheHint?: CacheHint;
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
  /**
   * Stable per conversation (derived from the session id). Providers with a routing key for their prompt cache
   * (OpenAI `prompt_cache_key`) may send it; others ignore it.
   */
  cacheKey?: string;
  signal: AbortSignal;
}

/**
 * Token usage of one call. `inputTokens` is the whole prompt, cached part included. `cachedTokens` were read from the
 * provider's prompt cache (hit), `cacheMissTokens` were not (`cachedTokens + cacheMissTokens = inputTokens` when both
 * are known), `cacheWriteTokens` were written to the cache on this call (Anthropic, OpenAI).
 */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  cacheMissTokens?: number;
  cacheWriteTokens?: number;
}

export type ProviderChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "done"; stopReason: string; usage: ProviderUsage };

export interface ModelInfo {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ProviderDefinition {
  protocol: string;
  stream(req: ProviderRequest): AsyncIterable<ProviderChunk>;
  /**
   * The provider's model list. `contextWindow` is the most input tokens the model takes, when the provider's API
   * says so (Anthropic `max_input_tokens`, OpenRouter `context_length`, ...); the core uses it for compaction.
   */
  listModels?(endpoint: ProviderEndpoint): Promise<ModelInfo[]>;
  /** Embeddings for `ctx.models.embed` and the builtin vector search. */
  embed?(req: EmbedProviderRequest): Promise<{ vectors: number[][]; usage?: { inputTokens: number } }>;
}

// ---- context ----

export interface ContextInput {
  sessionId: string;
  events: SintyEvent[];
  messages: ChatMessage[];
  budgetTokens: number;
}

/**
 * Context plugins run in order; each receives the previous output. They may only **append** messages at the tail:
 * the input must come back unchanged as the prefix of the output, so the provider's prompt cache keeps working.
 * When a contributor inserts, edits or removes earlier messages, the core keeps the input as it was, keeps only what
 * the contributor added after the last input message, and logs a warning (the context snapshot shows `reordered`).
 */
export type ContextContributor = (input: ContextInput) => Promise<ChatMessage[]>;

// ---- system sections ----

export interface SystemSectionInput {
  sessionId: string;
  /** The roster agent that speaks in this session; absent outside projects (the global persona speaks). */
  agent?: { id: string; name: string; skills: string[] };
}

/**
 * A stable block of the system zone of the prompt, placed right after the system prompt and before session memory
 * (docs/spec/protocol.md, "Prompt caching"). Return the same text for the same input, or the provider's prompt cache
 * misses from this block on: no clock, no counters, no random order. Return null or "" to add nothing. Called before
 * every model step; when it throws or times out (5 s) the core reuses the session's last good text.
 */
export type SystemSectionContributor = (input: SystemSectionInput) => string | null | Promise<string | null>;

export interface SystemSectionOptions {
  /** Lower first; ties keep plugins.enabled order. Default 100. */
  order?: number;
  /** How the context inspector labels the block. Default "system". */
  kind?: "system" | "skills";
}

// ---- channels ----

export interface ChannelDefinition {
  name: string;
  start(api: { deliver(msg: { sessionKey: string; text: string; externalId?: string }): Promise<void> }): Promise<void>;
  send(msg: { sessionId: string; text: string; state?: AgentState }): Promise<void>;
  stop?(): Promise<void>;
}

// ---- HTTP routes ----

export interface HttpRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";
  /** Relative to `/p/<plugin>`. `:name` matches one segment, a trailing `*` matches the rest. */
  path: string;
  /** Public routes skip the core's bearer token check; the plugin must authenticate callers itself. */
  public?: boolean;
  /** Screen a signed-in person reaches this route from: a `ui.tabs` id or `"settings"`. Default: the first tab, else settings. */
  surface?: string;
  /** Box on that screen the person needs. Default from the method: GET view, POST add, PUT/PATCH edit, DELETE delete. */
  access?: "view" | "add" | "edit" | "delete";
  handler(req: Request, info: { params: Record<string, string>; signal: AbortSignal }): Response | Promise<Response>;
}

// ---- agent access ----

export interface SessionInfo {
  id: string;
  title: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  metadata: Record<string, unknown>;
  /** Status of the running or blocked turn, if any. */
  activeTurn: { id: string; status: "running" | "blocked" } | null;
}

/** Talks to the agent like an API client would. Needs `permissions.agent`. */
export interface AgentApi {
  listSessions(opts?: { limit?: number }): Promise<SessionInfo[]>;
  getSession(id: string): Promise<SessionInfo | null>;
  events(sessionId: string, opts?: { afterSeq?: number; types?: EventType[]; limit?: number }): Promise<SintyEvent[]>;
  /** Journal events after `afterSeq`, then live events, until the signal aborts. */
  stream(sessionId: string, opts?: { afterSeq?: number; signal?: AbortSignal }): AsyncIterable<LiveEvent>;
  createSession(init?: { title?: string; projectId?: string; metadata?: Record<string, unknown> }): Promise<SessionInfo>;
  send(sessionId: string, text: string, opts?: { idempotencyKey?: string; channel?: string }): Promise<{ turnId: string }>;
  interrupt(sessionId: string): Promise<boolean>;
}

// ---- public internet through the core ----

export interface PublicFetchInit {
  method?: "GET" | "HEAD" | "POST";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Whole request including redirects. Default 20000, at most 60000. */
  timeoutMs?: number;
  /** Decoded body limit. Default 5000000, at most 20000000. A larger body fails with `too_large`. */
  maxBytes?: number;
  /** Default 5, at most 10. */
  maxRedirects?: number;
  /**
   * Over `maxBytes`, return the first `maxBytes` decoded bytes with `truncated: true` instead of failing with
   * `too_large`. Meant for pages read as text; leave it off for downloads and binary bodies.
   */
  truncate?: boolean;
}

/** A `Response` whose `url` is the final address; `truncated` is true when `truncate` cut the body at `maxBytes`. */
export type PublicFetchResponse = Response & { readonly truncated: boolean };

/** What the browser should use as its proxy; every connection through it gets the same checks as `fetch`. */
export interface PublicProxy {
  server: string;
  username: string;
  password: string;
}

/**
 * Public internet through the core (`permissions.net: ["$PUBLIC"]`). The core resolves the host, refuses loopback,
 * RFC 1918, link-local (169.254.169.254), CGNAT, IPv6 ULA/link-local and mapped forms, then connects to the address it
 * checked (no DNS rebinding) and checks again on every redirect. config.yaml `plugins.config.<plugin>.allowPrivate`
 * (set by the human) may let named private host[:port] entries through. Errors carry code `net_blocked`, `net_denied`,
 * `too_large`, `timeout` or `net_failed`.
 */
export interface PublicNet {
  /** Follows redirects itself; `response.url` is the final address. */
  fetch(url: string | URL, init?: PublicFetchInit): Promise<PublicFetchResponse>;
  /** Resolves and checks an http(s) url without fetching it; throws `net_blocked` like fetch would. */
  check(url: string | URL): Promise<void>;
  /** A loopback HTTP proxy owned by the core for this plugin process; needs `permissions.browser`. */
  proxy(): Promise<PublicProxy>;
}

// ---- setup context ----

export interface PluginContext {
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
  /** Absolute paths; the process can only write where `permissions.fs.write` allows. `data` is this plugin's own folder (`$DATA`). */
  readonly paths: { readonly workspace: string; readonly skills: string; readonly plugin: string; readonly data: string };
  readonly log: { debug(msg: string, data?: unknown): void; info(msg: string, data?: unknown): void; warn(msg: string, data?: unknown): void; error(msg: string, data?: unknown): void };

  /** Network access limited to `permissions.net`; `public` needs `"$PUBLIC"` there. */
  readonly net: { fetch(input: string | URL, init?: RequestInit): Promise<Response>; readonly public: PublicNet };
  /** Secret values by name from `permissions.secrets`; never journaled. */
  readonly secrets: { get(name: string): Promise<string> };
  /** Read-only journal access. */
  readonly journal: { read(sessionId: string, opts?: { afterSeq?: number; types?: EventType[] }): AsyncIterable<SintyEvent> };
  /** Calls fail with `agent_denied` unless the manifest grants the scope. */
  readonly agent: AgentApi;
  /** Model calls through the core. Fail with `models_denied` unless `permissions.models` lists the route. */
  readonly models: ModelsApi;
  /** Register memory providers and processors. Needs `"memory"` in the manifest kinds. */
  readonly memory: { provider(def: MemoryProviderDefinition): void; processor(def: MemoryProcessorDefinition): void };

  tool<I extends z.ZodType>(def: ToolDefinition<I>): void;
  provider(def: ProviderDefinition): void;
  context(name: string, contributor: ContextContributor, opts?: { order?: number }): void;
  /** A stable system-zone block of the prompt (see SystemSectionContributor). Hidden from agents whose card excludes the plugin. */
  systemSection(name: string, contributor: SystemSectionContributor, opts?: SystemSectionOptions): void;
  channel(def: ChannelDefinition): void;
  schedule(name: string, cron: string, run: (signal: AbortSignal) => Promise<void>): void;
  on<T extends EventType>(type: T | "*", handler: (event: SintyEvent<T>) => void | Promise<void>): void;
  http(route: HttpRoute): void;
  /** Called for every model step with what went into the prompt. Needs `permissions.context: ["inspect"]` and the plugin in config `plugins.inspect`; otherwise never called. */
  onContextSnapshot(handler: (snapshot: ContextSnapshot) => void | Promise<void>): void;
}

export interface PluginDefinition {
  name: string;
  setup(ctx: PluginContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}
