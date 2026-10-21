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
      CREATE TABLE IF NOT EXISTS turn_checkpoints (
        turn_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        view TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        fix_summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS patches (
        id TEXT PRIMARY KEY,
        plugin TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        files TEXT NOT NULL,
        permissions_changed INTEGER NOT NULL,
        test_output TEXT NOT NULL DEFAULT '',
        base_commit TEXT,
        commit_sha TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plugin_model_usage (
        plugin TEXT NOT NULL,
        day TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        PRIMARY KEY (plugin, day)
      );
    `);
  }

  /** Tokens a plugin spent through ctx.models on one UTC day (YYYY-MM-DD). Survives restarts. */
  pluginModelUsage(plugin: string, day: string): number {
    const row = this.db.prepare("SELECT tokens FROM plugin_model_usage WHERE plugin = ? AND day = ?").get(plugin, day) as { tokens: number } | undefined;
    return row?.tokens ?? 0;
  }

  /** Adds to a plugin's daily usage and drops rows older than 30 days. Returns the new total for that day. */
  addPluginModelUsage(plugin: string, day: string, tokens: number): number {
    this.db
      .prepare("INSERT INTO plugin_model_usage (plugin, day, tokens) VALUES (?, ?, ?) ON CONFLICT(plugin, day) DO UPDATE SET tokens = tokens + excluded.tokens")
      .run(plugin, day, Math.max(0, Math.round(tokens)));
    const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
    this.db.prepare("DELETE FROM plugin_model_usage WHERE day < ?").run(cutoff);
    return this.pluginModelUsage(plugin, day);
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

  deleteSession(id: string): boolean {
    if (!this.getSession(id)) return false;
    this.db.prepare("DELETE FROM events WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM turns WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return true;
  }

  patchSession(id: string, patch: { title?: string | null; projectId?: string | null }): SessionRow | undefined {
    const cur = this.getSession(id);
    if (!cur) return undefined;
    const title = patch.title === undefined ? cur.title : patch.title;
    const projectId = patch.projectId === undefined ? (cur.projectId ?? null) : patch.projectId;
    this.db.prepare("UPDATE sessions SET title = ?, project_id = ?, updated_at = ? WHERE id = ?").run(title, projectId, new Date().toISOString(), id);
    return this.getSession(id);
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

  turnEvents(turnId: string, afterSeq = 0): SintyEvent[] {
    return this.db.prepare("SELECT * FROM events WHERE turn_id = ? AND seq > ? ORDER BY seq").all(turnId, afterSeq).map(toEvent);
  }

  turnCheckpoint(turnId: string): { seq: number; view: string } | undefined {
    const row = this.db.prepare("SELECT seq, view FROM turn_checkpoints WHERE turn_id = ?").get(turnId) as { seq: number; view: string } | undefined;
    return row;
  }

  saveTurnCheckpoint(turnId: string, seq: number, view: string): void {
    this.db.prepare("INSERT INTO turn_checkpoints (turn_id, seq, view) VALUES (?, ?, ?) ON CONFLICT(turn_id) DO UPDATE SET seq = excluded.seq, view = excluded.view").run(turnId, seq, view);
  }

  clearTurnCheckpoint(turnId: string): void {
    this.db.prepare("DELETE FROM turn_checkpoints WHERE turn_id = ?").run(turnId);
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

  addIncident(i: Omit<IncidentRow, "createdAt">): IncidentRow {
    const createdAt = new Date().toISOString();
    this.db.prepare("INSERT INTO incidents (id, tool, code, message, fix_summary, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(i.id, i.tool, i.code, i.message, i.fixSummary, createdAt);
    return { ...i, createdAt };
  }

  incidents(limit = 500): IncidentRow[] {
    return this.db
      .prepare("SELECT * FROM incidents ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .reverse()
      .map((r) => ({ id: String(r.id), tool: String(r.tool), code: String(r.code), message: String(r.message), fixSummary: String(r.fix_summary), createdAt: String(r.created_at) }));
  }

  /** Rewrites stored incidents through `scrub` (secret masking); returns how many rows changed. */
  scrubIncidents(scrub: (text: string) => string): number {
    let changed = 0;
    const update = this.db.prepare("UPDATE incidents SET message = ?, fix_summary = ? WHERE id = ?");
    for (const r of this.db.prepare("SELECT id, message, fix_summary FROM incidents").all()) {
      const message = scrub(String(r.message));
      const fix = scrub(String(r.fix_summary));
      if (message !== String(r.message) || fix !== String(r.fix_summary)) {
        update.run(message, fix, String(r.id));
        changed++;
      }
    }
    return changed;
  }

  /** Deletes stored incidents that `drop` picks; returns how many. */
  dropIncidents(drop: (i: IncidentRow) => boolean): number {
    const del = this.db.prepare("DELETE FROM incidents WHERE id = ?");
    let n = 0;
    for (const i of this.incidents(1_000_000)) {
      if (!drop(i)) continue;
      del.run(i.id);
      n++;
    }
    return n;
  }

  /** Runs a one-time data fix once per journal (recorded in `migrations`); returns whether it ran now. */
  once(name: string, run: () => void): boolean {
    if (this.db.prepare("SELECT 1 FROM migrations WHERE name = ?").get(name)) return false;
    run();
    this.db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
    return true;
  }

  savePatch(p: PatchRow): void {
    this.db
      .prepare(
        `INSERT INTO patches (id, plugin, session_id, status, reason, files, permissions_changed, test_output, base_commit, commit_sha, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, test_output = excluded.test_output, base_commit = excluded.base_commit,
           commit_sha = excluded.commit_sha, updated_at = excluded.updated_at`,
      )
      .run(p.id, p.plugin, p.sessionId, p.status, p.reason, JSON.stringify(p.files), p.permissionsChanged ? 1 : 0, p.testOutput, p.baseCommit, p.commit, p.createdAt, new Date().toISOString());
  }

  getPatch(id: string): PatchRow | undefined {
    const r = this.db.prepare("SELECT * FROM patches WHERE id = ?").get(id);
    return r ? toPatch(r) : undefined;
  }

  listPatches(limit = 100): PatchRow[] {
    return this.db.prepare("SELECT * FROM patches ORDER BY created_at DESC LIMIT ?").all(limit).map(toPatch);
  }

  /** Latest events of the given types across all sessions, newest first. */
  recentEvents(types: readonly EventType[], limit = 100): SintyEvent[] {
    if (!types.length) return [];
    return this.db
      .prepare(`SELECT * FROM events WHERE type IN (${types.map(() => "?").join(",")}) ORDER BY ts DESC LIMIT ?`)
      .all(...types, limit)
      .map(toEvent);
  }

  /** Active turn status per session, for list views. */
  activeTurns(): TurnRow[] {
    return this.db.prepare("SELECT * FROM turns WHERE status IN ('running', 'blocked')").all().map(toTurn);
  }
}

function toPatch(r: Row): PatchRow {
  return {
    id: String(r.id),
    plugin: String(r.plugin),
    sessionId: String(r.session_id),
    status: String(r.status) as PatchStatus,
    reason: String(r.reason),
    files: JSON.parse(String(r.files)) as PatchFile[],
    permissionsChanged: Number(r.permissions_changed) === 1,
    testOutput: String(r.test_output),
    baseCommit: r.base_commit === null ? null : String(r.base_commit),
    commit: r.commit_sha === null ? null : String(r.commit_sha),
    createdAt: String(r.created_at),
  };
}

export interface IncidentRow {
  id: string;
  tool: string;
  code: string;
  message: string;
  fixSummary: string;
  createdAt: string;
}

export type PatchStatus = "failed_tests" | "ready" | "applied" | "rolled_back" | "rejected";

export interface PatchFile {
  path: string;
  content: string;
}

export interface PatchRow {
  id: string;
  plugin: string;
  sessionId: string;
  status: PatchStatus;
  reason: string;
  files: PatchFile[];
  permissionsChanged: boolean;
  testOutput: string;
  baseCommit: string | null;
  commit: string | null;
  createdAt: string;
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
