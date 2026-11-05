import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SintyEvent } from "@sinty/sdk";
import { summarize } from "./query.js";
import { openUsage } from "./store.js";

function ev(partial: Pick<SintyEvent, "type" | "data"> & { id: string; seq: number; ts: string; stepId?: string }): SintyEvent {
  return {
    id: partial.id,
    seq: partial.seq,
    ts: partial.ts,
    sessionId: "ses",
    type: partial.type,
    actor: { kind: "system", id: "system" },
    data: partial.data,
    ...(partial.stepId ? { stepId: partial.stepId } : {}),
  } as SintyEvent;
}

test("the index is idempotent, fills duration on a second pass, and prunes by age", () => {
  const dir = mkdtempSync(join(tmpdir(), "sinty-usage-"));
  const store = openUsage(join(dir, "usage.db"));
  try {
    const request = ev({ type: "model.request", id: "r", seq: 1, ts: "2026-11-01T00:00:00.000Z", stepId: "s", data: { route: "default", provider: "deepseek", model: "flash", messagesHash: "ab" } });
    const usage = ev({ type: "usage.recorded", id: "u", seq: 2, ts: "2026-11-01T00:00:02.000Z", stepId: "s", data: { provider: "deepseek", model: "flash", inputTokens: 10, outputTokens: 4, costUsd: 1.5 } });
    store.ingest("ses", usage, { title: "Чат" });
    store.ingest("ses", request, { title: "Чат" });
    store.ingest("ses", usage, { title: "Чат" });
    const calls = store.scan({}).calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.durationMs, 2000);
    assert.equal(calls[0]?.sessionTitle, "Чат");
    assert.equal(calls[0]?.costUsd, 1.5);
    assert.deepEqual(summarize(calls).totalTokens, 14);
    store.setCursor("ses", 2);
    assert.equal(store.cursor("ses"), 2);
    store.setCursor("ses", 1);
    assert.equal(store.cursor("ses"), 2, "cursor does not move backwards");
    const old = ev({ type: "usage.recorded", id: "old", seq: 1, ts: "2026-01-01T00:00:00.000Z", data: { provider: "deepseek", model: "flash", inputTokens: 1, outputTokens: 1 } });
    store.ingest("ses", old);
    assert.equal(store.prune(30, Date.parse("2026-11-05T00:00:00.000Z")), 1);
    assert.equal(store.count(), 1);
    assert.equal(store.scan({ model: "missing" }).calls.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
