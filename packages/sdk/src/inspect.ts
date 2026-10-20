import type { ChatMessage, ChatRole } from "./plugin.js";
import type { MemoryScope, MemoryTier } from "./memory.js";

/**
 * Context snapshots: what the core sent to the model on one step and where each message came from.
 * Delivered only to plugins whose manifest asks for `permissions.context: ["inspect"]` AND that the human listed in
 * config.yaml `plugins.inspect`. See docs/spec/context-inspect.md.
 */

export type ContextPartKind = "system" | "skills" | "memory" | "summary" | "recall" | "processor" | "plugin" | "dialogue";

/** One message of `ContextSnapshot.messages`, labelled. */
export interface ContextPart {
  /** Position in `messages`. */
  index: number;
  kind: ContextPartKind;
  /** "core", "builtin:sqlite", "journal" or the plugin that produced the text. */
  source: string;
  /** Memory block id (memory.profile, memory.summary, memory.recall…) or `<plugin>/<context>` for plugin parts. */
  id?: string;
  role: ChatRole;
  /** Same estimate the core uses for compaction: JSON length / 4. */
  tokens: number;
  untrusted?: boolean;
}

/** A memory processor hook that ran while this context was built. */
export interface ContextHookTrace {
  plugin: string;
  processor: string;
  hook: "onTurnStart" | "afterRecall" | "beforeContext";
  ms: number;
  /** False when the hook failed or timed out (the core then kept the previous value). */
  ok: boolean;
  /** The hook returned something different from its input. */
  changed: boolean;
  /** onTurnStart: recall queries it asked for. */
  queries?: string[];
  /** afterRecall: record ids; beforeContext: block ids. */
  before?: string[];
  after?: string[];
}

/** A plugin context contributor (`ctx.context(...)`) and what it changed. */
export interface ContextPluginTrace {
  plugin: string;
  name: string;
  ms: number;
  ok: boolean;
  error?: string;
  tokensBefore: number;
  tokensAfter: number;
  /** Messages the contributor added or removed, compared as whole messages. Content is cut at 4000 chars. */
  added: { index: number; role: ChatRole; content: string }[];
  removed: { index: number; role: ChatRole; content: string }[];
}

export interface ContextSnapshot {
  version: 1;
  /** `<stepId>`: unique per model step. */
  id: string;
  sessionId: string;
  turnId: string;
  stepId: string;
  /** 1-based model step within the turn. */
  step: number;
  at: string;
  agentId: string;
  /**
   * Where the persona (first system text) came from: `agent` = the roster agent's own AGENTS.md (`agentName`),
   * `global` = `~/.sinty/AGENTS.md`, used when the chat and its project have no agents.
   */
  persona?: { source: "agent" | "global"; agentName?: string };
  /** First model route that will be tried. */
  route?: string;
  /** Exactly the messages handed to the provider (after redaction, see `redactions`). */
  messages: ChatMessage[];
  parts: ContextPart[];
  tools: { name: string; tokens: number }[];
  tokens: { total: number; messages: number; tools: number; byKind: Partial<Record<ContextPartKind, number>> };
  memory: {
    /** Facts rendered into the memory.profile block (profile tier and the recent log). */
    facts: { id: string; text: string; tier: MemoryTier; scope: MemoryScope; source: string; createdAt: string }[];
    summary?: { text: string; coversUntil: number; tokens: number };
    /** Automatic recall of this turn; `cached` on later steps (computed on the first step). */
    recall?: { queries: string[]; records: { id: string; provider: string; text: string; untrusted?: boolean }[]; tokens: number; cached: boolean };
    hooks: ContextHookTrace[];
  };
  contexts: ContextPluginTrace[];
  /** How many strings had secrets replaced by "[redacted]". */
  redactions: number;
}
