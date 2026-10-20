import type { ChatMessage, ProviderEndpoint } from "./plugin.js";

/**
 * The memory contract. See docs/spec/memory.md for the full semantics.
 *
 * - A MemoryProvider stores and finds records (the core ships `builtin:sqlite`; plugins may add more).
 * - A MemoryProcessor hooks into the turn: it plans recall, filters records, edits context blocks,
 *   learns after a turn, can take over compaction and can veto or rewrite writes.
 * - Plugins never talk to the model provider directly for memory work: they use `ctx.models`,
 *   which goes through the core (secrets, routes, budgets, journal).
 */

export type MemoryTier = "profile" | "log" | "note";
export type MemoryScope = "user" | "agent" | "chat";
export type MemoryAbout = "user" | "work";

/** What the turn is about; passed to every hook. */
export interface TurnInfo {
  sessionId: string;
  turnId: string;
  /** Roster persona id that speaks, or config.agent.name outside projects. */
  agentId: string;
  userId: string;
  projectId?: string;
  /** Text of the newest human message of this turn. */
  text: string;
  /** Experiment arm when memory.experiments is configured. */
  arm?: string;
}

/** One remembered item, from any provider. */
export interface MemoryRecord {
  id: string;
  text: string;
  /** Provider name, e.g. "builtin:sqlite" or "memory-obsidian". */
  provider: string;
  tier?: MemoryTier;
  scope?: MemoryScope;
  source?: string;
  /** ISO date or timestamp. */
  createdAt?: string;
  /** Higher is better; providers use their own scale, the router only sorts within a provider. */
  score?: number;
  /** Where the record came from, e.g. a vault path. Shown to the model. */
  ref?: string;
  /**
   * Set by the router for every record that does not come from the builtin store. Untrusted records are
   * wrapped and secret-redacted before they reach the prompt; the model is told not to follow instructions in them.
   */
  untrusted?: boolean;
}

export interface RecallQuery {
  query: string;
  limit?: number;
  turn?: TurnInfo;
  /** Present when an embed route is configured. */
  embedding?: number[];
}

export interface MemoryWrite {
  text: string;
  tier: MemoryTier;
  scope: MemoryScope;
  about: MemoryAbout;
  source: string;
  agentId: string;
  chatId?: string;
}

export interface MemoryProviderDefinition {
  /** Unique within the plugin; the router addresses it as `<plugin>:<name>` unless the name is the plugin name. */
  name: string;
  recall(q: RecallQuery): Promise<MemoryRecord[]>;
  /** Optional: providers without write are read-only (e.g. a vault). */
  write?(w: MemoryWrite): Promise<{ id: string; action: "inserted" | "updated" }>;
  forget?(f: { id?: string; text?: string }): Promise<{ deleted: number }>;
}

/** What onTurnStart asks the router to recall automatically for this turn. */
export interface RecallPlan {
  queries: string[];
  limit?: number;
  /** Provider names; default: every provider listed in memory.recall.providers. */
  providers?: string[];
}

/** A block of context the router adds to the prompt as a system message. */
export interface ContextBlock {
  /** Stable id such as "memory.profile", "memory.summary", "memory.recalled". */
  id: string;
  content: string;
  /** Who produced it: "builtin:sqlite", a plugin name, ... */
  source: string;
  untrusted?: boolean;
}

export interface AfterTurnInput {
  turn: TurnInfo;
  /** The final agent message of the turn. */
  reply: string;
  /** User and agent messages of the turn, oldest first. */
  messages: { role: "user" | "assistant"; content: string }[];
}

export interface AfterTurnResult {
  facts?: { text: string; tier?: MemoryTier; scope?: MemoryScope; about?: MemoryAbout }[];
}

export interface CompactionInput {
  turn: TurnInfo;
  previous?: string;
  /** The folded part of the session as text, already truncated by the core. */
  transcript: string;
}

export interface CompactionResult {
  summary: string;
  facts: { text: string; tier: MemoryTier; about: MemoryAbout }[];
}

export type MemoryHook = "onTurnStart" | "afterRecall" | "beforeContext" | "afterTurn" | "onCompaction" | "onWrite";

export interface MemoryProcessorDefinition {
  name: string;
  /** Lower runs first. Default 100. */
  order?: number;
  onTurnStart?(turn: TurnInfo): Promise<RecallPlan | void>;
  afterRecall?(turn: TurnInfo, records: MemoryRecord[]): Promise<MemoryRecord[] | void>;
  /**
   * Runs once per turn on the blocks of the turn context (`memory.recalled`, `memory.updates`); the result is frozen
   * in the journal (`context.turn`) and replayed on later steps and after a restart, so it never rewrites earlier
   * prompt text. The session-level blocks (memory snapshot, summary) are not passed.
   */
  beforeContext?(turn: TurnInfo, blocks: ContextBlock[]): Promise<ContextBlock[] | void>;
  /**
   * Runs from a durable queue after the turn completed, at most once per turnId (retried up to 3 times on failure,
   * so it should be idempotent). Returned facts go through the normal write path (onWrite, builtin store,
   * `memory.written` with `source` = plugin name).
   */
  afterTurn?(input: AfterTurnInput): Promise<AfterTurnResult | void>;
  /** Return a result to replace the builtin summary call; return nothing to let the next processor or the core do it. */
  onCompaction?(input: CompactionInput): Promise<CompactionResult | void>;
  /** Return the (possibly edited) write, or null to drop it. */
  onWrite?(w: MemoryWrite, turn?: TurnInfo): Promise<MemoryWrite | null | void>;
}

// ---- models through the core ----

export interface CompleteRequest {
  /** "default", "cheap", a key of models.routes, or "provider/model". Default "default". */
  route?: string;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  /** Lets the core account usage to a session and journal the call there. */
  sessionId?: string;
}

export interface CompleteResult {
  text: string;
  provider: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface EmbedRequest {
  /** Default "embed" (models.routes.embed). */
  route?: string;
  input: string[];
  sessionId?: string;
}

export interface EmbedResult {
  vectors: number[][];
  provider: string;
  model: string;
  usage?: { inputTokens: number };
}

/** `ctx.models`: needs `permissions.models` in the manifest listing the routes the plugin may use. */
export interface ModelsApi {
  complete(req: CompleteRequest): Promise<CompleteResult>;
  embed(req: EmbedRequest): Promise<EmbedResult>;
}

/** Provider plugins may implement embeddings next to `stream`. */
export interface EmbedProviderRequest {
  endpoint: ProviderEndpoint;
  model: string;
  input: string[];
  signal: AbortSignal;
}

/** Short names used in docs/spec/memory.md. */
export type MemoryProvider = MemoryProviderDefinition;
export type MemoryProcessor = MemoryProcessorDefinition;
