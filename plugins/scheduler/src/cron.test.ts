import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cronDue, nextCronAfter, parseCron } from "./cron.js";
import { JobStore, computeNext, newJobId } from "./store.js";

test("parseCron: every 5 minutes", () => {
  const f = parseCron("*/5 * * * *");
  assert.deepEqual(f.minute, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  assert.equal(f.hour.length, 24);
});

test("parseCron: rejects bad arity", () => {
  assert.throws(() => parseCron("* * *"), /5 fields/);
});

test("nextCronAfter: advances past current minute", () => {
  const from = new Date(2026, 9, 25, 12, 0, 30);
  const next = nextCronAfter("*/5 * * * *", from);
  assert.equal(next.getFullYear(), 2026);
  assert.equal(next.getMonth(), 9);
  assert.equal(next.getDate(), 25);
  assert.equal(next.getHours(), 12);
  assert.equal(next.getMinutes(), 5);
  assert.equal(next.getSeconds(), 0);
});

test("cronDue: same local minute does not re-fire", () => {
  const now = new Date(2026, 9, 25, 12, 5, 10);
  const sameMinute = new Date(2026, 9, 25, 12, 5, 1);
  const earlier = new Date(2026, 9, 25, 12, 0, 1);
  assert.equal(cronDue("*/5 * * * *", null, now), true);
  assert.equal(cronDue("*/5 * * * *", sameMinute.toISOString(), now), false);
  assert.equal(cronDue("*/5 * * * *", earlier.toISOString(), now), true);
});

test("JobStore: persists cron job and computes next", () => {
  const dir = mkdtempSync(join(tmpdir(), "sinty-sched-"));
  try {
    const store = new JobStore(dir);
    const now = new Date(2026, 9, 25, 12, 0, 0);
    const job = {
      id: newJobId(),
      name: "pulse",
      kind: "cron" as const,
      cron: "0 * * * *",
      sessionId: "ses_test",
      text: "hello",
      enabled: true,
      createdAt: now.toISOString(),
      lastRunAt: null,
      nextRunAt: computeNext({ kind: "cron", cron: "0 * * * *", enabled: true }, now),
      runCount: 0,
    };
    store.upsert(job);
    const again = new JobStore(dir);
    const listed = again.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.name, "pulse");
    assert.ok(listed[0]!.nextRunAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeNext: at in the past returns null", () => {
  assert.equal(computeNext({ kind: "at", at: "2020-01-01T00:00:00Z", enabled: true }, new Date("2026-01-01T00:00:00Z")), null);
  assert.ok(computeNext({ kind: "at", at: "2099-01-01T00:00:00Z", enabled: true }, new Date("2026-01-01T00:00:00Z")));
});
