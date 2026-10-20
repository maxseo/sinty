import type { MemoryRecord, MemoryWrite } from "@sinty/sdk";
import { renderMemoryBlock, type MemoryFact, type MemoryStore, type MemoryWho, type SummaryRow } from "./memory.js";

export const BUILTIN = "builtin:sqlite";

/** The builtin store behind the memory contract. Synchronous: it runs in the core process (sqlite-vec needs that). */
export class BuiltinMemory {
  readonly name = BUILTIN;

  constructor(readonly store: MemoryStore) {}

  /** The "Memory you already know" block, exactly as before the router existed. */
  block(who: MemoryWho): string {
    this.store.expire();
    return renderMemoryBlock(this.store.profile(who), this.store.recentLog(10, who));
  }

  summary(chatId: string): SummaryRow | undefined {
    return this.store.getSummary(chatId);
  }

  saveSummary(chatId: string, text: string, coversUntil: number, tokens: number): void {
    this.store.saveSummary(chatId, text, coversUntil, tokens);
  }

  write(w: MemoryWrite, embedding?: Float32Array): { id: string; action: "inserted" | "updated" } {
    return this.store.write({
      text: w.text,
      tier: w.tier,
      scope: w.scope,
      about: w.about,
      source: w.source,
      agentId: w.agentId,
      ...(w.chatId ? { chatId: w.chatId } : {}),
      ...(embedding ? { embedding } : {}),
    });
  }

  recall(q: { query: string; chatId: string; agentId: string; embedding?: Float32Array; limit?: number }): MemoryFact[] {
    return this.store.recall({ query: q.query, chatId: q.chatId, agentId: q.agentId, ...(q.embedding ? { embedding: q.embedding } : {}), ...(q.limit ? { limit: q.limit } : {}) });
  }

  forget(f: { id?: string; text?: string }): number {
    return this.store.forget(f);
  }

  static toRecord(f: MemoryFact): MemoryRecord {
    return { id: f.id, text: f.text, provider: BUILTIN, tier: f.tier, scope: f.scope, source: f.source, createdAt: f.createdAt };
  }
}
