import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { STREAM_ONLY_EVENTS, type Actor, type EventDataMap, type EventType, type SintyEvent } from "@sinty/sdk";
import { ulid } from "./ids.js";

export type TurnStatus = "running" | "blocked" | "completed" | "failed" | "interrupted";

export interface SessionRow {
  id: string;
  title: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  metadata: Record<string, unknown>;
}

export interface TurnRow {
  id: string;
  sessionId: string;
  status: TurnStatus;
  startedAt: string;
  endedAt: string | null;
}

export interface AppendInput<T extends EventType> {
  sessionId: string;
  type: T;
  actor: Actor;
  data: EventDataMap[T];
  turnId?: string | undefined;
  stepId?: string | undefined;
  causationId?: string | undefined;
}

const STREAM_ONLY = new Set<string>(STREAM_ONLY_EVENTS);

/** Append-only event log. The core is the only writer. */
export class Journal {
  private readonly db: DatabaseSync;

  constructor(
    file: string,
    private readonly redact: (text: string) => string = (t) => t,
  ) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        project_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        turn_id TEXT,
        step_id TEXT,
        type TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        causation_id TEXT,
        data TEXT NOT NULL,
        UNIQUE (session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS events_turn ON events (turn_id, seq);
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE INDEX IF NOT EXISTS turns_status ON turns (status);
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createSession(id: string, init: { title?: string | undefined; projectId?: string | undefined; metadata?: Record<string, unknown> | undefined }): SessionRow {
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO sessions (id, title, project_id, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, init.title ?? null, init.projectId ?? null, now, now, JSON.stringify(init.metadata ?? {}));
    return this.getSession(id)!;
  }

  getSession(id: string): SessionRow | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? toSession(row) : undefined;
  }

  listSessions(limit = 100): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?").all(limit).map(toSession);
  }

  /** Writes the event durably and returns it. Stream-only types are rejected. */
  append<T extends EventType>(input: AppendInput<T>): SintyEvent<T> {
    if (STREAM_ONLY.has(input.type)) throw new Error(`${input.type} is stream-only`);
    const ts = new Date().toISOString();
    const id = ulid();
    const data = this.redact(JSON.stringify(input.data));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("UPDATE sessions SET last_seq = last_seq + 1, updated_at = ? WHERE id = ? RETURNING last_seq").get(ts, input.sessionId);
      if (!row) throw new Error(`unknown session ${input.sessionId}`);
      const seq = Number(row.last_seq);
      this.db
        .prepare("INSERT INTO events (id, session_id, seq, ts, turn_id, step_id, type, actor_kind, actor_id, causation_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.sessionId, seq, ts, input.turnId ?? null, input.stepId ?? null, input.type, input.actor.kind, input.actor.id, input.causationId ?? null, data);
      this.db.exec("COMMIT");
      return {
        id,
        seq,
        ts,
        sessionId: input.sessionId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.stepId ? { stepId: input.stepId } : {}),
        ...(input.causationId ? { causationId: input.causationId } : {}),
        type: input.type,
        actor: input.actor,
        data: JSON.parse(data) as EventDataMap[T],
      };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  events(sessionId: string, opts: { afterSeq?: number | undefined; types?: readonly EventType[] | undefined; limit?: number | undefined } = {}): SintyEvent[] {
    const params: SQLInputValue[] = [sessionId, opts.afterSeq ?? 0];
    let sql = "SELECT * FROM events WHERE session_id = ? AND seq > ?";
    if (opts.types?.length) {
      sql += ` AND type IN (${opts.types.map(() => "?").join(",")})`;
      params.push(...opts.types);
    }
    sql += " ORDER BY seq";
    if (opts.limit) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    return this.db.prepare(sql).all(...params).map(toEvent);
  }

  turnEvents(turnId: string): SintyEvent[] {
    return this.db.prepare("SELECT * FROM events WHERE turn_id = ? ORDER BY seq").all(turnId).map(toEvent);
  }

  startTurn(id: string, sessionId: string): void {
    this.db.prepare("INSERT INTO turns (id, session_id, status, started_at) VALUES (?, ?, 'running', ?)").run(id, sessionId, new Date().toISOString());
  }

  setTurnStatus(id: string, status: TurnStatus): void {
    const terminal = status === "completed" || status === "failed" || status === "interrupted";
    this.db.prepare("UPDATE turns SET status = ?, ended_at = ? WHERE id = ?").run(status, terminal ? new Date().toISOString() : null, id);
  }

  getTurn(id: string): TurnRow | undefined {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id);
    return row ? toTurn(row) : undefined;
  }

  turnsWithStatus(status: TurnStatus): TurnRow[] {
    return this.db.prepare("SELECT * FROM turns WHERE status = ? ORDER BY started_at").all(status).map(toTurn);
  }

  activeTurn(sessionId: string): TurnRow | undefined {
    const row = this.db.prepare("SELECT * FROM turns WHERE session_id = ? AND status IN ('running', 'blocked') ORDER BY started_at DESC LIMIT 1").get(sessionId);
    return row ? toTurn(row) : undefined;
  }

  idempotentTurn(key: string): { sessionId: string; turnId: string } | undefined {
    const row = this.db.prepare("SELECT session_id, turn_id FROM idempotency WHERE key = ?").get(key);
    return row ? { sessionId: String(row.session_id), turnId: String(row.turn_id) } : undefined;
  }

  rememberIdempotency(key: string, sessionId: string, turnId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO idempotency (key, session_id, turn_id, created_at) VALUES (?, ?, ?, ?)").run(key, sessionId, turnId, new Date().toISOString());
  }
}

type Row = Record<string, SQLInputValue>;

function toSession(r: Row): SessionRow {
  return {
    id: String(r.id),
    title: r.title === null ? null : String(r.title),
    projectId: r.project_id === null ? null : String(r.project_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    lastSeq: Number(r.last_seq),
    metadata: JSON.parse(String(r.metadata)) as Record<string, unknown>,
  };
}

function toTurn(r: Row): TurnRow {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    status: String(r.status) as TurnStatus,
    startedAt: String(r.started_at),
    endedAt: r.ended_at === null ? null : String(r.ended_at),
  };
}

function toEvent(r: Row): SintyEvent {
  return {
    id: String(r.id),
    seq: Number(r.seq),
    ts: String(r.ts),
    sessionId: String(r.session_id),
    ...(r.turn_id !== null ? { turnId: String(r.turn_id) } : {}),
    ...(r.step_id !== null ? { stepId: String(r.step_id) } : {}),
    ...(r.causation_id !== null ? { causationId: String(r.causation_id) } : {}),
    type: String(r.type) as EventType,
    actor: { kind: String(r.actor_kind) as Actor["kind"], id: String(r.actor_id) },
    data: JSON.parse(String(r.data)) as never,
  };
}
