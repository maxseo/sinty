import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_POLICY, brightness, freshStatus, homeFor, inRecall, isPast, spanFor, wantsHistory, type CardStatus, type CardType, type ClaimView, type Home, type Policy } from "./policy.js";

const SECRET = [
  /\b(sk|pk|rk|ghp|gho|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{12,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(password|passwd|пароль|api[_ -]?key|token|secret)\b\s*[:=]\s*\S+/i,
];

export function looksSecret(text: string): boolean {
  return SECRET.some((r) => r.test(text));
}

export function rememberLine(text: string): string | undefined {
  const line = text.split("\n").map((s) => s.trim()).find((s) => /^(запомни|remember)(?=\s|[:：]|$)/i.test(s));
  if (!line) return undefined;
  const body = line.replace(/^(запомни|remember)\s*[:：]?\s*/i, "").trim();
  if (body.length < 2 || looksSecret(body)) return undefined;
  return body;
}

export function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Calendar day on this machine. Night notes and "touched today" use this, not the UTC date inside the timestamp. */
export function localDay(when: string | Date = new Date()): string {
  const date = typeof when === "string" ? new Date(when) : when;
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export interface RememberInput {
  userId: string;
  agentId: string;
  sessionId: string;
  projectId?: string;
  text: string;
  kind: CardType;
  /** Stable key such as user.name. A new card with the same key replaces the current one. */
  subject?: string;
  basis: "user_requested" | "agent_inferred";
  evidenceId: string;
  quote: string;
  /** File path copied from the user's words. Empty when the card is not about a file. */
  path?: string;
  /** The user's words. An inferred card is kept only when quote is a piece of this text. */
  sourceText?: string;
  opKey: string;
  links?: { to: string; rel: "supports" | "contradicts" | "continues" }[];
}

export class MemoryV1Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT '',
        home TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        text_norm TEXT NOT NULL,
        basis TEXT NOT NULL,
        salience REAL NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        touched_at TEXT NOT NULL,
        span TEXT NOT NULL DEFAULT 'near',
        status TEXT NOT NULL DEFAULT 'current',
        subject TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS claims_owner ON claims (user_id, agent_id, valid_to);
      CREATE TABLE IF NOT EXISTS evidence (
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        quote TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS links (
        user_id TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        rel TEXT NOT NULL,
        PRIMARY KEY (user_id, from_id, to_id, rel)
      );
      CREATE TABLE IF NOT EXISTS operations (
        user_id TEXT NOT NULL,
        op_key TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (user_id, op_key)
      );
      CREATE TABLE IF NOT EXISTS days (
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        day TEXT NOT NULL,
        summary TEXT NOT NULL,
        researched INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, agent_id, day)
      );
      CREATE TABLE IF NOT EXISTS policies (
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        about_user INTEGER NOT NULL,
        project_work INTEGER NOT NULL,
        other_projects INTEGER NOT NULL,
        night INTEGER NOT NULL DEFAULT 0,
        research_at_night INTEGER NOT NULL DEFAULT 0,
        research_prompt TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (user_id, agent_id)
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(claims)").all() as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("span")) this.db.exec("ALTER TABLE claims ADD COLUMN span TEXT NOT NULL DEFAULT 'near'");
    if (!names.has("status")) this.db.exec("ALTER TABLE claims ADD COLUMN status TEXT NOT NULL DEFAULT 'current'");
    if (!names.has("subject")) this.db.exec("ALTER TABLE claims ADD COLUMN subject TEXT NOT NULL DEFAULT ''");
    if (!names.has("path")) this.db.exec("ALTER TABLE claims ADD COLUMN path TEXT NOT NULL DEFAULT ''");
    const policyCols = new Set((this.db.prepare("PRAGMA table_info(policies)").all() as { name: string }[]).map((column) => column.name));
    if (!policyCols.has("night")) this.db.exec("ALTER TABLE policies ADD COLUMN night INTEGER NOT NULL DEFAULT 0");
    if (!policyCols.has("research_at_night")) this.db.exec("ALTER TABLE policies ADD COLUMN research_at_night INTEGER NOT NULL DEFAULT 0");
    if (!policyCols.has("research_prompt")) this.db.exec("ALTER TABLE policies ADD COLUMN research_prompt TEXT NOT NULL DEFAULT ''");
    this.db.exec(`
      UPDATE claims SET kind = 'question', status = CASE WHEN valid_to IS NULL THEN 'open' ELSE 'answered' END WHERE kind = 'open';
      UPDATE claims SET span = 'long' WHERE kind IN ('decision', 'question');
      UPDATE claims SET span = 'near' WHERE kind IN ('person', 'preference', 'fact');
      UPDATE claims SET status = 'past' WHERE kind != 'question' AND valid_to IS NOT NULL AND status = 'current';
    `);
  }

  policy(userId: string, agentId: string): Policy {
    const row = this.db.prepare("SELECT mode, about_user, project_work, other_projects, night, research_at_night, research_prompt FROM policies WHERE user_id = ? AND agent_id = ?").get(userId, agentId) as
      | { mode: Policy["mode"]; about_user: number; project_work: number; other_projects: number; night?: number; research_at_night?: number; research_prompt?: string }
      | undefined;
    if (!row) return { ...DEFAULT_POLICY };
    return {
      mode: row.mode,
      aboutUser: row.about_user === 1,
      projectWork: row.project_work === 1,
      otherProjects: row.other_projects === 1,
      night: row.night === 1,
      researchAtNight: row.research_at_night === 1,
      researchPrompt: row.research_prompt ?? "",
    };
  }

  setPolicy(userId: string, agentId: string, policy: Policy): Policy {
    this.db.prepare(`INSERT INTO policies (user_id, agent_id, mode, about_user, project_work, other_projects, night, research_at_night, research_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, agent_id) DO UPDATE SET mode = excluded.mode, about_user = excluded.about_user, project_work = excluded.project_work, other_projects = excluded.other_projects, night = excluded.night, research_at_night = excluded.research_at_night, research_prompt = excluded.research_prompt`)
      .run(userId, agentId, policy.mode, policy.aboutUser ? 1 : 0, policy.projectWork ? 1 : 0, policy.otherProjects ? 1 : 0, policy.night ? 1 : 0, policy.researchAtNight ? 1 : 0, policy.researchPrompt.slice(0, 2000));
    return this.policy(userId, agentId);
  }

  remember(input: RememberInput): { id: string; action: "inserted" | "reinforced" | "replay" } {
    if (!input.userId || !input.agentId) throw Object.assign(new Error("user and agent are required"), { code: "AGENT_MEMORY_SCOPE_DENIED" });
    const text = input.text.replace(/\s+/g, " ").trim();
    if (!text || text.length > 500) throw Object.assign(new Error("claim text must be 1..500 characters"), { code: "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID" });
    if (looksSecret(text) || looksSecret(input.quote)) throw Object.assign(new Error("secrets are not stored"), { code: "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID" });
    const quote = input.quote.replace(/\s+/g, " ").trim().slice(0, 1000);
    const filePath = (input.path ?? "").trim().slice(0, 300);
    if (input.basis === "agent_inferred" && input.sourceText) {
      const source = normalize(input.sourceText);
      if (!quote || !source.includes(normalize(quote))) throw Object.assign(new Error("an inferred card needs a quote from the user's words"), { code: "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID" });
      if (filePath && !source.includes(normalize(filePath))) throw Object.assign(new Error("an inferred path must be copied from the user's words"), { code: "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID" });
    }
    if (!input.evidenceId) throw Object.assign(new Error("a claim needs evidence from this turn"), { code: "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID" });
    const subject = (input.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const hash = JSON.stringify({ text: normalize(text), kind: input.kind, subject, sessionId: input.sessionId, links: input.links ?? [] });
    const prev = this.db.prepare("SELECT input_hash, result FROM operations WHERE user_id = ? AND op_key = ?").get(input.userId, input.opKey) as { input_hash: string; result: string } | undefined;
    if (prev) {
      if (prev.input_hash !== hash) throw Object.assign(new Error("the same operation came back with different input"), { code: "AGENT_MEMORY_REPLAY_MISMATCH" });
      return { ...(JSON.parse(prev.result) as { id: string }), action: "replay" };
    }
    const norm = normalize(text);
    const home = homeFor(input.kind, input.projectId);
    const sameText = this.db.prepare(`SELECT id FROM claims WHERE user_id = ? AND agent_id = ? AND text_norm = ? AND valid_to IS NULL`).get(input.userId, input.agentId, norm) as { id: string } | undefined;
    const now = new Date().toISOString();
    const id = sameText?.id ?? `mem_${randomBytes(8).toString("hex")}`;
    const salience = input.basis === "user_requested" ? 1 : 0.6;
    const status = freshStatus(input.kind);
    this.db.exec("BEGIN");
    try {
      if (sameText) {
        this.db.prepare("UPDATE claims SET salience = 1, touched_at = ?, basis = ?, kind = ?, span = ?, subject = CASE WHEN ? != '' THEN ? ELSE subject END, path = CASE WHEN ? != '' THEN ? ELSE path END WHERE id = ? AND user_id = ?").run(now, input.basis, input.kind, spanFor(input.kind), subject, subject, filePath, filePath, id, input.userId);
      } else {
        const replaced = subject
          ? this.db.prepare(`SELECT id FROM claims WHERE user_id = ? AND agent_id = ? AND subject = ? AND subject != '' AND valid_to IS NULL`).all(input.userId, input.agentId, subject) as { id: string }[]
          : [];
        if (replaced.length) {
          this.db.prepare(`UPDATE claims SET status = 'past', valid_to = ?, touched_at = ? WHERE user_id = ? AND agent_id = ? AND subject = ? AND subject != '' AND valid_to IS NULL`).run(now, now, input.userId, input.agentId, subject);
        }
        this.db.prepare(`INSERT INTO claims (id, user_id, agent_id, session_id, project_id, home, kind, text, text_norm, basis, salience, valid_from, touched_at, span, status, subject, path)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.userId, input.agentId, input.sessionId, input.projectId ?? "", home, input.kind, text, norm, input.basis, salience, now, now, spanFor(input.kind), status, subject, filePath);
        for (const old of replaced) {
          this.db.prepare("INSERT OR IGNORE INTO links (user_id, from_id, to_id, rel) VALUES (?, ?, ?, 'supersedes')").run(input.userId, old.id, id);
        }
      }
      this.db.prepare("INSERT INTO evidence (user_id, claim_id, evidence_id, quote) VALUES (?, ?, ?, ?)").run(input.userId, id, input.evidenceId, quote.slice(0, 1000));
      for (const link of input.links ?? []) {
        const other = this.db.prepare("SELECT id FROM claims WHERE id = ? AND user_id = ?").get(link.to, input.userId);
        if (!other) throw Object.assign(new Error("link target is not in this user's memory"), { code: "AGENT_MEMORY_SCOPE_DENIED" });
        this.db.prepare("INSERT OR IGNORE INTO links (user_id, from_id, to_id, rel) VALUES (?, ?, ?, ?)").run(input.userId, id, link.to, link.rel);
      }
      const result = JSON.stringify({ id });
      this.db.prepare("INSERT INTO operations (user_id, op_key, input_hash, result) VALUES (?, ?, ?, ?)").run(input.userId, input.opKey, hash, result);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { id, action: sameText ? "reinforced" : "inserted" };
  }

  close(userId: string, agentId: string, id: string, opKey: string): { id: string; action: "closed" | "replay" } {
    const hash = JSON.stringify({ close: id });
    const prev = this.db.prepare("SELECT input_hash, result FROM operations WHERE user_id = ? AND op_key = ?").get(userId, opKey) as { input_hash: string; result: string } | undefined;
    if (prev) {
      if (prev.input_hash !== hash) throw Object.assign(new Error("the same operation came back with different input"), { code: "AGENT_MEMORY_REPLAY_MISMATCH" });
      return { id, action: "replay" };
    }
    const now = new Date().toISOString();
    const changed = this.db.prepare("UPDATE claims SET status = 'past', valid_to = ?, touched_at = ? WHERE id = ? AND user_id = ? AND agent_id = ? AND valid_to IS NULL").run(now, now, id, userId, agentId);
    if (Number(changed.changes) !== 1) throw Object.assign(new Error("claim is not current for this user"), { code: "AGENT_MEMORY_SCOPE_DENIED" });
    this.db.prepare("INSERT INTO operations (user_id, op_key, input_hash, result) VALUES (?, ?, ?, ?)").run(userId, opKey, hash, JSON.stringify({ id }));
    return { id, action: "closed" };
  }

  findClaim(userId: string, id: string): ClaimView | undefined {
    const row = this.db.prepare("SELECT * FROM claims WHERE user_id = ? AND id = ?").get(userId, id) as Record<string, string | number | null> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      agentId: String(row.agent_id),
      sessionId: String(row.session_id),
      projectId: String(row.project_id),
      home: row.home as Home,
      kind: (row.kind === "open" ? "question" : row.kind) as CardType,
      span: spanFor((row.kind === "open" ? "question" : row.kind) as CardType),
      status: (row.status as CardStatus | undefined) ?? (row.valid_to ? "past" : freshStatus((row.kind === "open" ? "question" : row.kind) as CardType)),
      subject: String(row.subject ?? ""),
      path: String(row.path ?? ""),
      text: String(row.text),
      salience: Number(row.salience),
      validTo: row.valid_to ? String(row.valid_to) : null,
      touchedAt: String(row.touched_at),
    };
  }

  /** Person and preference cards first, then facts, inside a short index. */
  prompt(userId: string, agentId: string, limit = 40, here?: { sessionId: string; projectId?: string }): ClaimView[] {
    const policy = here ? this.policy(userId, agentId) : undefined;
    const seen = new Set<string>();
    const ranked = this.list(userId, agentId)
      .filter((claim) => claim.span === "near" && !isPast(claim.status) && !claim.validTo && (!here || !policy || inRecall(claim, here, policy)))
      .sort((a, b) => rank(a.kind) - rank(b.kind) || (a.touchedAt < b.touchedAt ? 1 : -1));
    const out: ClaimView[] = [];
    let chars = 0;
    for (const claim of ranked) {
      const key = claim.subject || normalize(claim.text);
      if (seen.has(key)) continue;
      if (chars + claim.text.length > 3000 && out.length) break;
      seen.add(key);
      chars += claim.text.length;
      out.push(claim);
      if (out.length === limit) break;
    }
    return out;
  }

  timeline(userId: string, agentId: string): { day: string; summary: string; researched: boolean; cards: number }[] {
    const days = this.db.prepare("SELECT day, summary, researched FROM days WHERE user_id = ? AND agent_id = ? ORDER BY day DESC LIMIT 60").all(userId, agentId) as { day: string; summary: string; researched: number }[];
    return days.map((row) => ({
      day: row.day,
      summary: row.summary,
      researched: row.researched === 1,
      cards: this.list(userId, agentId).filter((card) => localDay(card.touchedAt) === row.day).length,
    }));
  }

  saveDay(userId: string, agentId: string, day: string, summary: string, researched: boolean): void {
    this.db.prepare(`INSERT INTO days (user_id, agent_id, day, summary, researched) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, agent_id, day) DO UPDATE SET summary = excluded.summary, researched = excluded.researched`)
      .run(userId, agentId, day, summary.slice(0, 4000), researched ? 1 : 0);
  }

  agentsForNight(): { userId: string; agentId: string }[] {
    return (this.db.prepare("SELECT user_id, agent_id FROM policies WHERE night = 1").all() as { user_id: string; agent_id: string }[])
      .map((row) => ({ userId: row.user_id, agentId: row.agent_id }));
  }

  /** The card plus the quote and the journal id it was taken from. */
  source(userId: string, agentId: string, id: string): (ClaimView & { evidenceId: string }) | undefined {
    const claim = this.findClaim(userId, id);
    if (!claim || claim.agentId !== agentId) return undefined;
    const evidence = this.db.prepare("SELECT evidence_id, quote FROM evidence WHERE user_id = ? AND claim_id = ? ORDER BY id DESC LIMIT 1").get(userId, id) as { evidence_id: string; quote: string } | undefined;
    return { ...claim, quote: evidence?.quote ?? claim.quote ?? "", evidenceId: evidence?.evidence_id ?? "" };
  }

  /** Sets a subject on a current card and closes the previous card with that subject. */
  setSubject(userId: string, agentId: string, id: string, subject: string): boolean {
    const next = subject.replace(/\s+/g, " ").trim().slice(0, 80);
    if (next.length < 2) return false;
    const claim = this.findClaim(userId, id);
    if (!claim || claim.agentId !== agentId || claim.validTo) return false;
    const now = new Date().toISOString();
    const replaced = this.db.prepare("SELECT id FROM claims WHERE user_id = ? AND agent_id = ? AND subject = ? AND valid_to IS NULL AND id != ?").all(userId, agentId, next, id) as { id: string }[];
    this.db.exec("BEGIN");
    try {
      if (replaced.length) this.db.prepare("UPDATE claims SET status = 'past', valid_to = ?, touched_at = ? WHERE user_id = ? AND agent_id = ? AND subject = ? AND valid_to IS NULL AND id != ?").run(now, now, userId, agentId, next, id);
      this.db.prepare("UPDATE claims SET subject = ?, touched_at = ? WHERE id = ? AND user_id = ?").run(next, now, id, userId);
      for (const old of replaced) this.db.prepare("INSERT OR IGNORE INTO links (user_id, from_id, to_id, rel) VALUES (?, ?, ?, 'supersedes')").run(userId, old.id, id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return true;
  }

  addLink(userId: string, from: string, to: string, rel: "supports" | "contradicts" | "continues"): boolean {
    const left = this.findClaim(userId, from);
    const right = this.findClaim(userId, to);
    if (!left || !right || left.agentId !== right.agentId) return false;
    this.db.prepare("INSERT OR IGNORE INTO links (user_id, from_id, to_id, rel) VALUES (?, ?, ?, ?)").run(userId, from, to, rel);
    return true;
  }

  search(userId: string, agentId: string, here: { sessionId: string; projectId?: string }, query: string, limit = 12): (ClaimView & { match: number })[] {
    const policy = this.policy(userId, agentId);
    const history = wantsHistory(query);
    const words = normalize(query).split(" ").filter((w) => w.length > 1);
    const quotes = this.quotesFor(userId);
    return this.list(userId, agentId)
      .map((claim) => ({ claim, score: score(`${claim.text} ${claim.subject} ${claim.path} ${quotes.get(claim.id) ?? ""}`, words) }))
      .filter((row) => row.score > 0 && inRecall(row.claim, here, policy, history))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((row) => ({ ...row.claim, quote: quotes.get(row.claim.id) ?? "", match: row.score }));
  }

  graph(userId: string, agentId: string, here: { sessionId: string; projectId?: string }): { policy: Policy; nodes: (ClaimView & { bright: number; inRecall: boolean })[]; edges: { from: string; to: string; rel: string }[] } {
    const policy = this.policy(userId, agentId);
    const quotes = new Map<string, string>();
    for (const row of this.db.prepare("SELECT claim_id, quote FROM evidence WHERE user_id = ? ORDER BY id DESC").all(userId) as { claim_id: string; quote: string }[]) {
      if (!quotes.has(row.claim_id)) quotes.set(row.claim_id, row.quote);
    }
    const nodes = this.list(userId, agentId).map((claim) => ({ ...claim, quote: quotes.get(claim.id) ?? "", bright: isPast(claim.status) || claim.validTo ? 0.15 : brightness(claim.salience, claim.touchedAt), inRecall: inRecall(claim, here, policy) }));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = (this.db.prepare("SELECT from_id, to_id, rel FROM links WHERE user_id = ?").all(userId) as { from_id: string; to_id: string; rel: string }[])
      .filter((edge) => ids.has(edge.from_id) && ids.has(edge.to_id))
      .map((edge) => ({ from: edge.from_id, to: edge.to_id, rel: edge.rel }));
    const seen = new Set(edges.map((edge) => `${edge.from}|${edge.to}|${edge.rel}`));
    const bySubject = new Map<string, ClaimView[]>();
    for (const node of nodes) {
      if (!node.subject) continue;
      const group = bySubject.get(node.subject) ?? [];
      group.push(node);
      bySubject.set(node.subject, group);
    }
    for (const group of bySubject.values()) {
      const current = group.filter((node) => !node.validTo);
      for (const past of group.filter((node) => node.validTo)) {
        for (const next of current) {
          const key = `${past.id}|${next.id}|supersedes`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ from: past.id, to: next.id, rel: "supersedes" });
        }
      }
    }
    return { policy, nodes, edges };
  }

  private quotesFor(userId: string): Map<string, string> {
    const quotes = new Map<string, string>();
    for (const row of this.db.prepare("SELECT claim_id, quote FROM evidence WHERE user_id = ? ORDER BY id DESC").all(userId) as { claim_id: string; quote: string }[]) {
      if (!quotes.has(row.claim_id)) quotes.set(row.claim_id, row.quote);
    }
    return quotes;
  }

  private list(userId: string, agentId: string): ClaimView[] {
    const rows = this.db.prepare("SELECT * FROM claims WHERE user_id = ? AND agent_id = ?").all(userId, agentId) as Record<string, string | number | null>[];
    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      agentId: String(row.agent_id),
      sessionId: String(row.session_id),
      projectId: String(row.project_id),
      home: row.home as Home,
      kind: (row.kind === "open" ? "question" : row.kind) as CardType,
      span: spanFor((row.kind === "open" ? "question" : row.kind) as CardType),
      status: (row.status as CardStatus | undefined) ?? (row.valid_to ? "past" : freshStatus((row.kind === "open" ? "question" : row.kind) as CardType)),
      subject: String(row.subject ?? ""),
      path: String(row.path ?? ""),
      text: String(row.text),
      salience: Number(row.salience),
      validTo: row.valid_to ? String(row.valid_to) : null,
      touchedAt: String(row.touched_at),
      basis: String(row.basis ?? ""),
      validFrom: row.valid_from ? String(row.valid_from) : "",
    }));
  }
}

function rank(kind: CardType): number {
  if (kind === "person") return 0;
  if (kind === "preference") return 1;
  return 2;
}

function score(text: string, words: string[]): number {
  if (words.length === 0) return 0;
  const hay = normalize(text);
  const hits = words.filter((w) => hay.includes(w)).length;
  return hits / words.length;
}
