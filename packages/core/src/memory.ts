import { STEM_VERSION, stemText } from "./stem.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getLoadablePath } from "sqlite-vec";
import type { ChatMessage } from "@sinty/sdk";
import { isHumanMessage } from "./prompt.js";

export type MemoryTier = "profile" | "log" | "note";
export type MemoryScope = "user" | "agent" | "chat";
export type MemoryAbout = "user" | "work";

export interface MemoryFact {
  id: string;
  tier: MemoryTier;
  text: string;
  source: string;
  about: MemoryAbout;
  scope: MemoryScope;
  createdAt: string;
  lastUsedAt: string;
}

export interface SummaryRow {
  text: string;
  coversUntil: number;
  tokens: number;
}

const PROFILE_CAP = 40;
const NOTE_DAYS = 14;

export class MemoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

interface FactRow {
  id: string;
  tier: MemoryTier;
  text: string;
  source: string;
  about: MemoryAbout;
  agent_id: string;
  chat_id: string;
  created_at: string;
  last_used_at: string;
}

/** Who is asking: the persona (roster agent id) and the chat. Missing agentId falls back to the store default. */
export interface MemoryWho {
  agentId?: string | undefined;
  chatId?: string | undefined;
}

/**
 * Facts, FTS5 and sqlite-vec in one file. Empty agent_id/chat_id means "not scoped there".
 * One instance stays open for the life of the core (see MemoryRouter); agentId is passed per call
 * so one connection serves every persona.
 */
export class MemoryStore {
  private readonly db: DatabaseSync;
  readonly vec: boolean;

  constructor(
    file: string,
    private readonly opts: { userId: string; agentId?: string; dimensions: number },
  ) {
    mkdirSync(dirname(file), { recursive: true });
    const opened = openDatabase(file);
    this.db = opened.db;
    this.vec = opened.vec;
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_facts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '',
        chat_id TEXT NOT NULL DEFAULT '',
        tier TEXT NOT NULL,
        about TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        expires_at TEXT,
        hash TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS memory_facts_hash ON memory_facts (user_id, agent_id, chat_id, hash);
      CREATE INDEX IF NOT EXISTS memory_facts_tier ON memory_facts (user_id, tier, created_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(text, fact_id UNINDEXED);
      CREATE TABLE IF NOT EXISTS summaries (
        chat_id TEXT PRIMARY KEY,
        covers_until INTEGER NOT NULL,
        text TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    // Stemmed copy of every fact for recall by word form: Russian stems from stem.ts, English by the porter tokenizer.
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS facts_stem USING fts5(stems, fact_id UNINDEXED, tokenize = 'porter unicode61 remove_diacritics 2')`);
    this.rebuildStemsIfStale();
    if (this.vec && !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'facts_vec'").get()) {
      this.db.exec(`CREATE VIRTUAL TABLE facts_vec USING vec0(embedding float[${this.opts.dimensions}], fact_id text)`);
    }
  }

  /**
   * facts_stem is derived data: built for every existing fact the first time a database is opened by a core with
   * stemming, and again whenever STEM_VERSION changes (memory_meta "fts.stem"). One transaction; a few ms per 1000 facts.
   */
  private rebuildStemsIfStale(): void {
    const row = this.db.prepare("SELECT value FROM memory_meta WHERE key = 'fts.stem'").get() as { value: string } | undefined;
    if (row?.value === STEM_VERSION) return;
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM facts_stem");
      const insert = this.db.prepare("INSERT INTO facts_stem (stems, fact_id) VALUES (?, ?)");
      for (const r of this.db.prepare("SELECT id, text FROM memory_facts").all() as { id: string; text: string }[]) insert.run(stemText(r.text), r.id);
      this.db.prepare("INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('fts.stem', ?)").run(STEM_VERSION);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  get dimensions(): number {
    return this.opts.dimensions;
  }

  /** The raw connection, for tables that live next to the facts (the afterTurn job queue). */
  get database(): DatabaseSync {
    return this.db;
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private agent(agentId?: string): string {
    return agentId ?? this.opts.agentId ?? "";
  }

  expire(now = new Date()): number {
    const rows = this.db.prepare("SELECT id FROM memory_facts WHERE expires_at IS NOT NULL AND expires_at <= ?").all(now.toISOString()) as { id: string }[];
    for (const r of rows) this.deleteId(r.id);
    return rows.length;
  }

  write(input: {
    text: string;
    tier: MemoryTier;
    scope: MemoryScope;
    about: MemoryAbout;
    source: string;
    chatId?: string;
    agentId?: string;
    embedding?: Float32Array;
  }): { id: string; action: "inserted" | "updated" } {
    const agentId = this.agent(input.agentId);
    const text = input.text.trim();
    if (!text) throw new MemoryError("empty", "a memory fact needs one sentence");
    if (input.scope === "chat" && !input.chatId) throw new MemoryError("scope", "chat scope needs a chat id");
    if (input.embedding && input.embedding.length !== this.opts.dimensions) {
      throw new MemoryError("embedding", `embedding length ${input.embedding.length} does not match ${this.opts.dimensions}`);
    }
    const scope = this.scopeKeys(input.scope, agentId, input.chatId);
    const hash = factHash(text);
    const now = new Date();
    const existing = this.db
      .prepare("SELECT id, agent_id, chat_id, created_at FROM memory_facts WHERE user_id = ? AND hash = ?")
      .all(this.opts.userId, hash) as { id: string; agent_id: string; chat_id: string; created_at: string }[];

    if (input.about === "work") {
      const agentCopy = agentId ? existing.find((r) => r.agent_id === agentId) : undefined;
      if (agentCopy && scope.agentId !== agentId) return { id: agentCopy.id, action: "updated" };
      if (agentId && scope.agentId === agentId) {
        for (const row of existing) if (row.agent_id !== agentId) this.deleteId(row.id);
      }
    }
    if (input.about === "user") {
      for (const row of existing) {
        if (row.agent_id !== scope.agentId || row.chat_id !== scope.chatId) this.deleteId(row.id);
      }
    }

    const same = this.db
      .prepare("SELECT id FROM memory_facts WHERE user_id = ? AND agent_id = ? AND chat_id = ? AND hash = ?")
      .get(this.opts.userId, scope.agentId, scope.chatId, hash) as { id: string } | undefined;
    if (same) {
      this.db.prepare("UPDATE memory_facts SET source = ?, last_used_at = ?, about = ? WHERE id = ?").run(input.source, now.toISOString(), input.about, same.id);
      this.syncFts(same.id, text);
      this.syncVec(same.id, input.embedding);
      return { id: same.id, action: "updated" };
    }

    if (input.tier === "profile") {
      const n = this.db.prepare("SELECT count(*) AS n FROM memory_facts WHERE user_id = ? AND tier = 'profile'").get(this.opts.userId) as { n: number };
      if (n.n >= PROFILE_CAP) {
        throw new MemoryError("profile_full", `profile already has ${PROFILE_CAP} facts`, "Forget one with memory.forget before adding another.");
      }
    }

    const id = randomUUID();
    const expires = input.tier === "note" ? new Date(now.getTime() + NOTE_DAYS * 86_400_000).toISOString() : null;
    this.db
      .prepare(
        `INSERT INTO memory_facts (id, user_id, agent_id, chat_id, tier, about, text, source, created_at, last_used_at, expires_at, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, this.opts.userId, scope.agentId, scope.chatId, input.tier, input.about, text, input.source, now.toISOString(), now.toISOString(), expires, hash);
    this.syncFts(id, text);
    this.syncVec(id, input.embedding);
    return { id, action: "inserted" };
  }

  forget(input: { id?: string; text?: string }): number {
    if (input.id) {
      const row = this.db.prepare("SELECT id FROM memory_facts WHERE id = ? AND user_id = ?").get(input.id, this.opts.userId) as { id: string } | undefined;
      if (!row) return 0;
      this.deleteId(row.id);
      return 1;
    }
    const text = input.text?.trim();
    if (!text) throw new MemoryError("empty", "forget needs an id or the fact text");
    const rows = this.db.prepare("SELECT id FROM memory_facts WHERE user_id = ? AND hash = ?").all(this.opts.userId, factHash(text)) as { id: string }[];
    for (const r of rows) this.deleteId(r.id);
    return rows.length;
  }

  /** Journal and notes. Profile is omitted: it is already in the prompt. */
  recall(input: { query: string; chatId: string; agentId?: string; embedding?: Float32Array; limit?: number }): MemoryFact[] {
    this.expire();
    const limit = Math.min(input.limit ?? 15, 20);
    const pool = this.visible(input.chatId, this.agent(input.agentId)).filter((r) => r.tier !== "profile");
    const byId = new Map(pool.map((r) => [r.id, r]));
    const fts = this.ftsIds(input.query).filter((id) => byId.has(id));
    const vec = this.vecIds(input.embedding).filter((id) => byId.has(id));
    let ranked = rrf([fts, vec]);
    if (!ranked.length && input.query.trim()) {
      const q = input.query.trim().toLowerCase();
      ranked = pool.filter((r) => r.text.toLowerCase().includes(q)).map((r) => r.id);
    }
    const now = Date.now();
    const scored = ranked
      .map((id) => {
        const row = byId.get(id)!;
        const ageDays = (now - Date.parse(row.created_at)) / 86_400_000;
        const rank = ranked.indexOf(id);
        return { row, score: (1 / (60 + rank)) * Math.exp(-ageDays / 90) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    const ids = scored.map((s) => s.row.id);
    if (ids.length) {
      const stamp = new Date().toISOString();
      const stmt = this.db.prepare("UPDATE memory_facts SET last_used_at = ? WHERE id = ?");
      for (const id of ids) stmt.run(stamp, id);
    }
    return scored.map((s) => this.toFact(s.row));
  }

  /** Profile facts this persona may see: user-wide, its own agent facts and facts of this chat. */
  profile(who: MemoryWho = {}): MemoryFact[] {
    this.expire();
    return this.visible(who.chatId ?? "", this.agent(who.agentId))
      .filter((r) => r.tier === "profile")
      .sort((a, b) => cmp(a.created_at, b.created_at))
      .map((r) => this.toFact(r));
  }

  /** The newest journal facts this persona may see, oldest first. */
  recentLog(limit = 10, who: MemoryWho = {}): MemoryFact[] {
    this.expire();
    return this.visible(who.chatId ?? "", this.agent(who.agentId))
      .filter((r) => r.tier === "log")
      .sort((a, b) => cmp(b.created_at, a.created_at))
      .slice(0, limit)
      .reverse()
      .map((r) => this.toFact(r));
  }

  /** Every fact this persona may see, newest first; used by offline eval and exports. */
  all(who: MemoryWho = {}): MemoryFact[] {
    return this.visible(who.chatId ?? "", this.agent(who.agentId))
      .sort((a, b) => cmp(b.created_at, a.created_at))
      .map((r) => this.toFact(r));
  }

  getSummary(chatId: string): SummaryRow | undefined {
    const row = this.db.prepare("SELECT text, covers_until, tokens FROM summaries WHERE chat_id = ?").get(chatId) as { text: string; covers_until: number; tokens: number } | undefined;
    return row ? { text: row.text, coversUntil: row.covers_until, tokens: row.tokens } : undefined;
  }

  saveSummary(chatId: string, text: string, coversUntil: number, tokens: number): void {
    this.db
      .prepare(
        `INSERT INTO summaries (chat_id, covers_until, text, tokens, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET covers_until = excluded.covers_until, text = excluded.text, tokens = excluded.tokens, created_at = excluded.created_at`,
      )
      .run(chatId, coversUntil, text, tokens, new Date().toISOString());
  }

  private visible(chatId: string, agentId: string): FactRow[] {
    const now = new Date().toISOString();
    return rows<FactRow>(
      this.db
        .prepare(
          `SELECT * FROM memory_facts
           WHERE user_id = ? AND (agent_id = '' OR agent_id = ?) AND (chat_id = '' OR chat_id = ?)
             AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .all(this.opts.userId, agentId, chatId, now),
    );
  }

  /**
   * Full-text candidates, best first: facts with every word (AND), then with every word in any form (AND over
   * stems: "сводку компакции" finds "сводка компакция", "deployed servers" finds "deploying the server"), then with
   * any word of 3+ letters (OR), then with any of their stems (OR), then with a word that starts like one of them
   * (OR over crude prefixes, for forms the stemmer keeps apart: "память" → "памя", "памяти" → "памят").
   * Each stage is ranked by FTS5 bm25; later stages only add ids the earlier ones did not return.
   */
  private ftsIds(query: string): string[] {
    const words = ftsWords(query);
    if (!words.length) return [];
    const loose = words.filter((t) => [...t].length >= 3);
    const stems = (ws: string[]): string[] => [...new Set(ws.flatMap((w) => stemText(w).split(" ")).filter(Boolean))];
    const raw = "SELECT fact_id FROM facts_fts WHERE facts_fts MATCH ? ORDER BY rank LIMIT 50";
    const stemmed = "SELECT fact_id FROM facts_stem WHERE facts_stem MATCH ? ORDER BY rank LIMIT 50";
    const stages: [string, string][] = [[raw, words.map((t) => `"${t}"`).join(" AND ")]];
    const all = stems(words);
    if (all.length) stages.push([stemmed, all.map((t) => `"${t}"`).join(" AND ")]);
    if (loose.length) {
      stages.push([raw, loose.map((t) => `"${t}"`).join(" OR ")]);
      const some = stems(loose);
      if (some.length) stages.push([stemmed, some.map((t) => `"${t}"`).join(" OR ")]);
      stages.push([raw, [...new Set(loose.map(ftsStem))].map((t) => `"${t}"*`).join(" OR ")]);
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const [sql, q] of stages) {
      const stmt = this.db.prepare(sql);
      if (out.length >= 50) break;
      let rows: { fact_id: string }[] = [];
      try {
        rows = stmt.all(q) as { fact_id: string }[];
      } catch {
        continue;
      }
      for (const r of rows) {
        if (seen.has(r.fact_id)) continue;
        seen.add(r.fact_id);
        out.push(r.fact_id);
      }
    }
    return out.slice(0, 50);
  }

  /** How many live facts have no vector yet. 0 when sqlite-vec is not loaded. */
  countMissingVectors(): number {
    if (!this.vec) return 0;
    const row = this.db
      .prepare("SELECT count(*) AS n FROM memory_facts WHERE (expires_at IS NULL OR expires_at > ?) AND id NOT IN (SELECT fact_id FROM facts_vec)")
      .get(new Date().toISOString()) as { n: number };
    return Number(row.n);
  }

  /** The oldest live facts without a vector. */
  missingVectors(limit: number): { id: string; text: string }[] {
    if (!this.vec) return [];
    return rows<{ id: string; text: string }>(
      this.db
        .prepare("SELECT id, text FROM memory_facts WHERE (expires_at IS NULL OR expires_at > ?) AND id NOT IN (SELECT fact_id FROM facts_vec) ORDER BY created_at, id LIMIT ?")
        .all(new Date().toISOString(), limit),
    );
  }

  /** Stores the vector of an existing fact (replacing an old one). Returns false when the fact is gone. */
  setVector(id: string, embedding: Float32Array): boolean {
    if (!this.vec) return false;
    if (embedding.length !== this.opts.dimensions) throw new MemoryError("embedding", `embedding length ${embedding.length} does not match ${this.opts.dimensions}`);
    if (!this.db.prepare("SELECT 1 FROM memory_facts WHERE id = ?").get(id)) return false;
    this.syncVec(id, embedding);
    return true;
  }

  private vecIds(embedding?: Float32Array): string[] {
    if (!this.vec || !embedding) return [];
    try {
      const rows = this.db.prepare("SELECT fact_id FROM facts_vec WHERE embedding MATCH ? AND k = 50").all(embedding) as { fact_id: string }[];
      return rows.map((r) => r.fact_id);
    } catch {
      return [];
    }
  }

  private scopeKeys(scope: MemoryScope, agentId: string, chatId?: string): { agentId: string; chatId: string } {
    if (scope === "user") return { agentId: "", chatId: "" };
    if (scope === "agent") return { agentId, chatId: "" };
    return { agentId, chatId: chatId ?? "" };
  }

  private syncFts(id: string, text: string): void {
    this.db.prepare("DELETE FROM facts_fts WHERE fact_id = ?").run(id);
    this.db.prepare("INSERT INTO facts_fts (text, fact_id) VALUES (?, ?)").run(text, id);
    this.db.prepare("DELETE FROM facts_stem WHERE fact_id = ?").run(id);
    this.db.prepare("INSERT INTO facts_stem (stems, fact_id) VALUES (?, ?)").run(stemText(text), id);
  }

  private syncVec(id: string, embedding?: Float32Array): void {
    if (!this.vec || !embedding) return;
    this.db.prepare("DELETE FROM facts_vec WHERE fact_id = ?").run(id);
    this.db.prepare("INSERT INTO facts_vec (embedding, fact_id) VALUES (?, ?)").run(embedding, id);
  }

  private deleteId(id: string): void {
    this.db.prepare("DELETE FROM memory_facts WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM facts_fts WHERE fact_id = ?").run(id);
    this.db.prepare("DELETE FROM facts_stem WHERE fact_id = ?").run(id);
    if (this.vec) this.db.prepare("DELETE FROM facts_vec WHERE fact_id = ?").run(id);
  }

  private toFact(r: FactRow): MemoryFact {
    const scope: MemoryScope = r.chat_id ? "chat" : r.agent_id ? "agent" : "user";
    return { id: r.id, tier: r.tier, text: r.text, source: r.source, about: r.about, scope, createdAt: r.created_at, lastUsedAt: r.last_used_at };
  }

}

function openDatabase(file: string): { db: DatabaseSync; vec: boolean } {
  try {
    const db = new DatabaseSync(file, { allowExtension: true });
    db.enableLoadExtension(true);
    db.loadExtension(getLoadablePath());
    return { db, vec: true };
  } catch {
    return { db: new DatabaseSync(file), vec: false };
  }
}

export function factHash(text: string): string {
  return createHash("sha256").update(text.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex");
}

/** Lowercased query words for FTS5 (letters, digits, _ and -), at most 12, quotes removed. */
export function ftsWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((t) => t.replaceAll('"', ""))
    .filter((t) => [...t].length > 1)
    .slice(0, 12);
}

/**
 * Crude language-neutral stem for prefix search: words longer than 5 letters lose up to their last 3 letters,
 * keeping at least 4 ("памяти" → "памя", "deploying" → "deploy", "компакции" → "компак").
 */
export function ftsStem(word: string): string {
  const chars = [...word];
  return chars.length > 5 ? chars.slice(0, Math.max(4, chars.length - 3)).join("") : word;
}

export function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/**
 * Older tool results shrink to 15 lines; the last `keepUsers` human turns stay verbatim. The boundary moves in
 * steps of `step` turns (counted from the start of the dialogue), not on every turn: a rolling cut rewrote one more
 * old turn on every new message and broke the provider's prompt cache from there on. Now the prefix changes once
 * every `step` turns. Supervisor notices and turn contexts are not human turns.
 */
export function trimOldToolResults(messages: ChatMessage[], keepUsers = 12, step = 8): ChatMessage[] {
  const humans: number[] = [];
  messages.forEach((m, i) => {
    if (isHumanMessage(m)) humans.push(i);
  });
  const old = humans.length - keepUsers;
  if (old <= 0) return messages;
  const turns = Math.floor(old / Math.max(1, step)) * Math.max(1, step);
  if (turns === 0) return messages;
  const cut = humans[turns]!;
  return messages.map((m, i) => {
    if (i >= cut || m.role !== "tool") return m;
    const lines = m.content.split("\n").slice(0, 15).join("\n");
    return lines.length < m.content.length ? { ...m, content: `${lines}\n…[older tool output truncated]` } : m;
  });
}

export function parseSummaryPayload(raw: string): { summary: string; facts: { text: string; tier: MemoryTier; about: MemoryAbout }[] } | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { summary?: unknown; facts?: unknown };
    if (typeof parsed.summary !== "string" || !parsed.summary.trim()) return undefined;
    const facts: { text: string; tier: MemoryTier; about: MemoryAbout }[] = [];
    if (Array.isArray(parsed.facts)) {
      for (const f of parsed.facts) {
        if (!f || typeof f !== "object") continue;
        const row = f as { text?: unknown; tier?: unknown; about?: unknown };
        if (typeof row.text !== "string" || !row.text.trim()) continue;
        const tier: MemoryTier = row.tier === "profile" || row.tier === "note" ? row.tier : "log";
        const about: MemoryAbout = row.about === "work" ? "work" : "user";
        facts.push({ text: row.text.trim(), tier, about });
      }
    }
    return { summary: parsed.summary.trim(), facts };
  } catch {
    return undefined;
  }
}

export function renderMemoryBlock(profile: MemoryFact[], logs: MemoryFact[]): string {
  const lines = ["Memory you already know. Do not repeat it back unless asked."];
  lines.push("Profile:");
  lines.push(profile.length ? profile.map((f) => `- ${f.text}`).join("\n") : "- (empty)");
  lines.push("Recent journal:");
  lines.push(logs.length ? logs.map((f) => `- ${f.createdAt.slice(0, 10)} ${f.text}`).join("\n") : "- (empty)");
  lines.push("Write a durable fact with memory.write. Remove a wrong one with memory.forget. Search older facts with memory.recall when the answer is not in this block.");
  return lines.join("\n");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rows<T>(value: unknown): T[] {
  return value as T[];
}

function rrf(lists: string[][]): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank)));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
