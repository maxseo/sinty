import { join } from "node:path";
import type { ChatMessage, MemoryAbout, MemoryScope, MemoryTier, MemoryWrite, SintyEvent } from "@sinty/sdk";
import type { SintyConfig } from "./config.js";
import type { AppendInput } from "./journal.js";
import { estimateTokens, MemoryStore } from "./memory.js";
import { BUILTIN, BuiltinMemory } from "./memory-builtin.js";

export type SummaryFacts = { summary: string; facts: { text: string; tier: MemoryTier; about: MemoryAbout }[] };

/** Who is talking: the session and the persona whose agent-scoped memory applies. */
export interface MemoryCtx {
  sessionId: string;
  agentId: string;
}

export interface MemoryRouterDeps {
  dataDir: string;
  config: SintyConfig;
  record(input: AppendInput<"memory.written" | "memory.compacted" | "memory.degraded" | "memory.recalled" | "memory.experiment">): void;
  log?: ((level: string, msg: string, data?: unknown) => void) | undefined;
}

export interface CompactInput extends MemoryCtx {
  events: SintyEvent[];
  dialogue: ChatMessage[];
  signal: AbortSignal;
  toMessages(events: SintyEvent[]): ChatMessage[];
  /** The builtin summary call (speaker service model → service.model → speaker model → default). */
  summarize(previous: string | undefined, head: SintyEvent[], signal: AbortSignal): Promise<SummaryFacts | undefined>;
}

const KEEP_USER_TURNS = 12;

/**
 * The single entry point for memory in the core: prompt blocks, memory tools and compaction.
 * Owns one long-lived builtin store (one SQLite connection).
 */
export class MemoryRouter {
  private builtinStore: BuiltinMemory | undefined;

  constructor(private readonly d: MemoryRouterDeps) {}

  get builtin(): BuiltinMemory {
    this.builtinStore ??= new BuiltinMemory(
      new MemoryStore(join(this.d.dataDir, "memory", "memory.db"), {
        userId: this.d.config.agent.userId,
        agentId: this.d.config.agent.name,
        dimensions: this.d.config.memory.dimensions,
      }),
    );
    return this.builtinStore;
  }

  close(): void {
    this.builtinStore?.store.close();
    this.builtinStore = undefined;
  }

  /** System messages that carry memory: the profile/journal block and the conversation summary. */
  contextMessages(ctx: MemoryCtx): ChatMessage[] {
    const b = this.builtin;
    const out: ChatMessage[] = [{ role: "system", content: b.block({ agentId: ctx.agentId, chatId: ctx.sessionId }) }];
    const summary = b.summary(ctx.sessionId);
    if (summary) out.push({ role: "system", content: `<conversation_summary>\n${summary.text}\n</conversation_summary>` });
    return out;
  }

  /** memory.write / memory.recall / memory.forget. Throws MemoryError for the agent to turn into a tool error. */
  tool(name: string, args: unknown, ctx: MemoryCtx): unknown {
    const a = args as { text?: string; tier?: MemoryTier; scope?: MemoryScope; about?: MemoryAbout; source?: string; id?: string; query?: string; embedding?: number[] };
    const b = this.builtin;
    if (name === "memory.write") {
      const w: MemoryWrite = {
        text: a.text ?? "",
        tier: a.tier ?? "log",
        scope: a.scope ?? "user",
        about: a.about ?? "user",
        source: a.source ?? "agent",
        agentId: ctx.agentId,
        ...(a.scope === "chat" ? { chatId: ctx.sessionId } : {}),
      };
      return b.write(w);
    }
    if (name === "memory.forget") {
      return { deleted: b.forget({ ...(a.id ? { id: a.id } : {}), ...(a.text ? { text: a.text } : {}) }) };
    }
    const embedding = a.embedding ? Float32Array.from(a.embedding) : undefined;
    return b.recall({ query: a.query ?? "", chatId: ctx.sessionId, agentId: ctx.agentId, ...(embedding ? { embedding } : {}) }).map((f) => ({
      id: f.id,
      tier: f.tier,
      scope: f.scope,
      date: f.createdAt.slice(0, 10),
      source: f.source,
      text: f.text,
    }));
  }

  /** When history passes 65% of the window, fold the older part into a summary and keep the last 12 user turns. */
  async compact(input: CompactInput): Promise<ChatMessage[]> {
    const { sessionId, events, dialogue } = input;
    const limit = Math.floor(this.d.config.memory.contextTokens * 0.65);
    if (estimateTokens(dialogue) < limit) return dialogue;
    const userIdx = events.map((e, i) => (e.type === "message.user" ? i : -1)).filter((i) => i >= 0);
    if (userIdx.length <= KEEP_USER_TURNS) return dialogue;
    const start = userIdx[userIdx.length - KEEP_USER_TURNS] ?? 0;
    const head = events.slice(0, start);
    const tail = events.slice(start);
    const last = head.at(-1);
    if (!last) return dialogue;
    const b = this.builtin;
    const prev = b.summary(sessionId);
    const tailMessages = input.toMessages(tail);
    if (prev && prev.coversUntil >= last.seq && estimateTokens([{ role: "system", content: prev.text }, ...tailMessages]) < limit) return tailMessages;
    const folded = await input.summarize(prev?.text, head, input.signal);
    if (!folded) return dialogue;
    b.saveSummary(sessionId, folded.summary, last.seq, estimateTokens([{ role: "system", content: folded.summary }]));
    this.storeSummaryFacts(input, folded);
    return tailMessages;
  }

  private storeSummaryFacts(ctx: MemoryCtx, folded: SummaryFacts): void {
    for (const fact of folded.facts) {
      try {
        const scope: MemoryScope = fact.about === "work" ? "agent" : "user";
        const saved = this.builtin.write({ text: fact.text, tier: fact.tier, about: fact.about, scope, source: "summary", chatId: ctx.sessionId, agentId: ctx.agentId });
        this.d.record({ sessionId: ctx.sessionId, type: "memory.written", actor: { kind: "system", id: "memory" }, data: { id: saved.id, action: saved.action, tier: fact.tier, scope, source: "summary", provider: BUILTIN } });
      } catch (e) {
        this.d.log?.("warn", "memory fact from summary was not stored", e instanceof Error ? e.message : e);
      }
    }
  }
}

