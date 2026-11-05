import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SintyEvent } from "@sinty/sdk";
import { applyJournalEvent, createFold, type Fold, type FoldHint } from "./fold.js";
import type { UsageCall, UsageFilter } from "./types.js";

/** Enough for charts on a laptop install. The table itself is not trimmed by this cap. */
export const SCAN_CAP = 20_000;

export interface Scan {
  calls: UsageCall[];
  truncated: boolean;
}

function row(r: Record<string, unknown>): UsageCall {
  return {
    id: String(r.id),
    ts: String(r.ts),
    seq: Number(r.seq),
    sessionId: String(r.session_id),
    turnId: String(r.turn_id),
    stepId: String(r.step_id),
    sessionTitle: String(r.session_title),
    sessionKind: r.session_kind === "task" ? "task" : "chat",
    agentId: String(r.agent_id),
    agentName: String(r.agent_name),
    provider: String(r.provider),
    model: String(r.model),
    route: String(r.route),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cachedTokens: r.cached_tokens == null ? null : Number(r.cached_tokens),
    cacheMissTokens: r.cache_miss_tokens == null ? null : Number(r.cache_miss_tokens),
    cacheWriteTokens: r.cache_write_tokens == null ? null : Number(r.cache_write_tokens),
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    stopReason: String(r.stop_reason),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    source: r.source === "plugin" ? "plugin" : "chat",
    plugin: String(r.plugin),
  };
}

function where(filter: UsageFilter): { sql: string; args: SQLInputValue[] } {
  const parts: string[] = [];
  const args: SQLInputValue[] = [];
  if (filter.from) {
    parts.push("ts >= ?");
    args.push(filter.from);
  }
  if (filter.to) {
    parts.push("ts < ?");
    args.push(filter.to);
  }
  if (filter.model) {
    parts.push("model = ?");
    args.push(filter.model);
  }
  if (filter.provider) {
    parts.push("provider = ?");
    args.push(filter.provider);
  }
  if (filter.agent) {
    parts.push("(agent_id = ? OR agent_name = ?)");
    args.push(filter.agent, filter.agent);
  }
  if (filter.session) {
    parts.push("session_id = ?");
    args.push(filter.session);
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", args };
}

export interface UsageStore {
  ingest(sessionId: string, event: SintyEvent, hint?: FoldHint): void;
  cursor(sessionId: string): number;
  setCursor(sessionId: string, seq: number): void;
  scan(filter: UsageFilter): Scan;
  count(): number;
  oldest(): string | null;
  newest(): string | null;
  prune(retainDays: number, now?: number): number;
  close(): void;
}

export function openUsage(file: string): UsageStore {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL DEFAULT '',
      step_id TEXT NOT NULL DEFAULT '',
      session_title TEXT NOT NULL DEFAULT '',
      session_kind TEXT NOT NULL DEFAULT 'chat',
      agent_id TEXT NOT NULL DEFAULT '',
      agent_name TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      route TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER,
      cache_miss_tokens INTEGER,
      cache_write_tokens INTEGER,
      cost_usd REAL,
      stop_reason TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER,
      source TEXT NOT NULL DEFAULT 'chat',
      plugin TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS calls_ts ON calls (ts);
    CREATE INDEX IF NOT EXISTS calls_session ON calls (session_id, ts);
    CREATE TABLE IF NOT EXISTS cursors (
      session_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL
    );
  `);
  const upsert = db.prepare(`INSERT INTO calls (
      id, ts, seq, session_id, turn_id, step_id, session_title, session_kind, agent_id, agent_name,
      provider, model, route, input_tokens, output_tokens, cached_tokens, cache_miss_tokens, cache_write_tokens,
      cost_usd, stop_reason, duration_ms, source, plugin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      duration_ms = COALESCE(calls.duration_ms, excluded.duration_ms),
      stop_reason = CASE WHEN calls.stop_reason = '' THEN excluded.stop_reason ELSE calls.stop_reason END,
      agent_id = CASE WHEN calls.agent_id = '' THEN excluded.agent_id ELSE calls.agent_id END,
      agent_name = CASE WHEN calls.agent_name = '' THEN excluded.agent_name ELSE calls.agent_name END,
      session_title = CASE WHEN calls.session_title = '' THEN excluded.session_title ELSE calls.session_title END,
      cached_tokens = COALESCE(calls.cached_tokens, excluded.cached_tokens),
      cache_miss_tokens = COALESCE(calls.cache_miss_tokens, excluded.cache_miss_tokens),
      cache_write_tokens = COALESCE(calls.cache_write_tokens, excluded.cache_write_tokens),
      cost_usd = COALESCE(calls.cost_usd, excluded.cost_usd),
      route = CASE WHEN calls.route = '' THEN excluded.route ELSE calls.route END,
      session_kind = CASE WHEN calls.session_kind = 'chat' AND excluded.session_kind = 'task' THEN 'task' ELSE calls.session_kind END`);
  const setAgent = db.prepare(`UPDATE calls SET
      agent_id = CASE WHEN agent_id = '' THEN ? ELSE agent_id END,
      agent_name = CASE WHEN agent_name = '' THEN ? ELSE agent_name END
    WHERE session_id = ? AND turn_id = ? AND source = 'chat'`);
  const setTitle = db.prepare("UPDATE calls SET session_title = ? WHERE session_id = ?");
  const setDuration = db.prepare("UPDATE calls SET duration_ms = ? WHERE id = ? AND duration_ms IS NULL");
  const setStop = db.prepare("UPDATE calls SET stop_reason = ? WHERE id = ? AND stop_reason = ''");
  const readCursor = db.prepare("SELECT seq FROM cursors WHERE session_id = ?");
  const writeCursor = db.prepare(`INSERT INTO cursors (session_id, seq) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET seq = MAX(seq, excluded.seq)`);
  const folds = new Map<string, Fold>();

  function foldOf(sessionId: string, hint?: FoldHint): Fold {
    let fold = folds.get(sessionId);
    if (!fold) {
      fold = createFold(hint);
      folds.set(sessionId, fold);
    } else if (hint?.title && !fold.title) fold.title = hint.title;
    if (hint?.task) fold.task = true;
    return fold;
  }

  return {
    ingest(sessionId, event, hint) {
      const fold = foldOf(sessionId, hint);
      for (const effect of applyJournalEvent(fold, event)) {
        if (effect.type === "call") {
          const c = effect.call;
          upsert.run(
            c.id, c.ts, c.seq, c.sessionId, c.turnId, c.stepId, c.sessionTitle, c.sessionKind, c.agentId, c.agentName,
            c.provider, c.model, c.route, c.inputTokens, c.outputTokens, c.cachedTokens, c.cacheMissTokens, c.cacheWriteTokens,
            c.costUsd, c.stopReason, c.durationMs, c.source, c.plugin,
          );
        } else if (effect.type === "agent") {
          setAgent.run(effect.agentId, effect.agentName, effect.sessionId, effect.turnId);
        } else if (effect.type === "title") {
          setTitle.run(effect.title, effect.sessionId);
        } else if (effect.type === "duration") {
          setDuration.run(effect.durationMs, effect.id);
        } else {
          setStop.run(effect.stopReason, effect.id);
        }
      }
    },
    cursor(sessionId) {
      const found = readCursor.get(sessionId) as { seq: number } | undefined;
      return found?.seq ?? 0;
    },
    setCursor(sessionId, seq) {
      writeCursor.run(sessionId, seq);
    },
    scan(filter) {
      const w = where(filter);
      const total = db.prepare(`SELECT COUNT(*) AS n FROM calls ${w.sql}`).get(...w.args) as { n: number };
      const rows = db.prepare(`SELECT * FROM calls ${w.sql} ORDER BY ts ASC, seq ASC LIMIT ?`).all(...w.args, SCAN_CAP) as Record<string, unknown>[];
      return { calls: rows.map(row), truncated: total.n > rows.length };
    },
    count() {
      return (db.prepare("SELECT COUNT(*) AS n FROM calls").get() as { n: number }).n;
    },
    oldest() {
      const found = db.prepare("SELECT ts FROM calls ORDER BY ts ASC LIMIT 1").get() as { ts: string } | undefined;
      return found?.ts ?? null;
    },
    newest() {
      const found = db.prepare("SELECT ts FROM calls ORDER BY ts DESC LIMIT 1").get() as { ts: string } | undefined;
      return found?.ts ?? null;
    },
    prune(retainDays, now = Date.now()) {
      if (!Number.isFinite(retainDays) || retainDays <= 0) return 0;
      const cutoff = new Date(now - retainDays * 86_400_000).toISOString();
      const result = db.prepare("DELETE FROM calls WHERE ts < ?").run(cutoff);
      return Number(result.changes ?? 0);
    },
    close() {
      db.close();
    },
  };
}
