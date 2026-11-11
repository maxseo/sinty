import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
/** Coins and dollars, when the task response carries them. Absent fields stay empty. */
export function moneyOf(raw) {
    const rec = record(raw);
    const flat = { ...rec, ...record(rec.data) };
    return { coins: scalar(flat.consumeCoins ?? flat.rhCoin ?? flat.coins), amount: scalar(flat.consumeMoney ?? flat.amount ?? flat.cost) };
}
export function openHistory(file) {
    mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE IF NOT EXISTS generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL DEFAULT '',
    endpoint TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT '',
    outputs TEXT NOT NULL DEFAULT '',
    coins TEXT NOT NULL DEFAULT '',
    amount TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT ''
  )`);
    const insert = db.prepare(`INSERT INTO generations
    (task_id, endpoint, name, status, started_at, finished_at, duration_ms, error, payload, outputs, coins, amount, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const select = db.prepare(`SELECT id, task_id, endpoint, name, status, started_at, finished_at, duration_ms, error, payload, outputs, coins, amount, detail
    FROM generations ORDER BY id DESC LIMIT ?`);
    return {
        add(row) {
            insert.run(row.taskId, row.endpoint, row.name, row.status, row.startedAt, row.finishedAt, row.durationMs, row.error, row.payload, row.outputs, row.coins, row.amount, row.detail.slice(0, 20_000));
        },
        list(limit = 200) {
            return select.all(Math.min(Math.max(limit, 1), 500)).map(generationOf);
        },
        close() {
            db.close();
        },
    };
}
function generationOf(row) {
    return {
        id: Number(row.id),
        taskId: String(row.task_id ?? ""),
        endpoint: String(row.endpoint ?? ""),
        name: String(row.name ?? ""),
        status: String(row.status ?? ""),
        startedAt: String(row.started_at ?? ""),
        finishedAt: String(row.finished_at ?? ""),
        durationMs: Number(row.duration_ms ?? 0),
        error: String(row.error ?? ""),
        payload: String(row.payload ?? ""),
        outputs: String(row.outputs ?? ""),
        coins: String(row.coins ?? ""),
        amount: String(row.amount ?? ""),
        detail: String(row.detail ?? ""),
    };
}
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function scalar(value) {
    return typeof value === "number" || typeof value === "string" ? String(value) : "";
}
//# sourceMappingURL=history.js.map