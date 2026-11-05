import assert from "node:assert/strict";
import test from "node:test";
import { bucketKey, chooseBucket, facetsOf, pageOf, seriesOf, summarize, tasksOf, tokenParts } from "./query.js";
import type { UsageCall } from "./types.js";

function call(partial: Partial<UsageCall> & Pick<UsageCall, "id" | "ts">): UsageCall {
  return {
    seq: 1,
    sessionId: "ses",
    turnId: "t",
    stepId: "s",
    sessionTitle: "Чат",
    sessionKind: "chat",
    agentId: "agt",
    agentName: "Макс",
    provider: "deepseek",
    model: "deepseek-flash",
    route: "default",
    inputTokens: 10,
    outputTokens: 2,
    cachedTokens: null,
    cacheMissTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    stopReason: "stop",
    durationMs: 100,
    source: "chat",
    plugin: "",
    ...partial,
  };
}

test("token parts stay input-only when the provider did not report a cache", () => {
  assert.deepEqual(tokenParts(call({ id: "a", ts: "2026-11-05T12:00:00.000Z", inputTokens: 100, outputTokens: 5 })), { hit: 0, miss: 0, plain: 100, output: 5 });
  assert.deepEqual(tokenParts(call({ id: "b", ts: "2026-11-05T12:00:00.000Z", inputTokens: 1000, cachedTokens: 900, cacheMissTokens: 100, outputTokens: 5 })), { hit: 900, miss: 100, plain: 0, output: 5 });
  assert.deepEqual(tokenParts(call({ id: "c", ts: "2026-11-05T12:00:00.000Z", inputTokens: 1000, cachedTokens: 900, outputTokens: 5 })), { hit: 900, miss: 100, plain: 0, output: 5 });
});

test("summary does not invent dollars", () => {
  const sum = summarize([
    call({ id: "a", ts: "2026-11-05T12:00:00.000Z", inputTokens: 10, outputTokens: 1 }),
    call({ id: "b", ts: "2026-11-05T13:00:00.000Z", inputTokens: 4, outputTokens: 1, costUsd: 0.02 }),
  ]);
  assert.equal(sum.requests, 2);
  assert.equal(sum.totalTokens, 16);
  assert.equal(sum.hasCost, true);
  assert.equal(sum.costUsd, 0.02);
  assert.equal(sum.pricedCalls, 1);
  const none = summarize([call({ id: "a", ts: "2026-11-05T12:00:00.000Z" })]);
  assert.equal(none.hasCost, false);
  assert.equal(none.costUsd, null);
});

test("hourly buckets follow the browser offset and stack models", () => {
  assert.equal(bucketKey("2026-11-05T12:00:00.000Z", "hour", -180), "2026-11-05T15");
  assert.equal(chooseBucket(2 * 3_600_000), "hour");
  assert.equal(chooseBucket(10 * 86_400_000), "day");
  assert.equal(chooseBucket(200 * 86_400_000), "week");
  const series = seriesOf([
    call({ id: "a", ts: "2026-11-05T12:00:00.000Z", model: "flash", inputTokens: 10, outputTokens: 0 }),
    call({ id: "b", ts: "2026-11-05T12:30:00.000Z", model: "pro", inputTokens: 4, outputTokens: 0 }),
    call({ id: "c", ts: "2026-11-05T14:00:00.000Z", model: "flash", inputTokens: 1, outputTokens: 0 }),
  ], { from: "2026-11-05T12:00:00.000Z", to: "2026-11-05T15:00:00.000Z" }, -180, Date.parse("2026-11-05T15:00:00.000Z"));
  assert.equal(series.bucket, "hour");
  assert.deepEqual(series.points.map((p) => p.label), ["15:00", "16:00", "17:00"]);
  assert.deepEqual(series.points.map((p) => p.requests), [2, 0, 1]);
  const flash = series.models.find((m) => m.model === "flash");
  const pro = series.models.find((m) => m.model === "pro");
  assert.deepEqual(flash?.values, [10, 0, 1]);
  assert.deepEqual(pro?.values, [4, 0, 0]);
});

test("filters, tasks and pages", () => {
  const rows = [
    call({ id: "a", ts: "2026-11-05T12:00:00.000Z", sessionId: "s1", sessionTitle: "Один", inputTokens: 10, outputTokens: 0 }),
    call({ id: "b", ts: "2026-11-05T13:00:00.000Z", sessionId: "s1", sessionTitle: "Один", model: "pro", inputTokens: 1, outputTokens: 1 }),
    call({ id: "c", ts: "2026-11-05T18:00:00.000Z", sessionId: "s2", sessionTitle: "", sessionKind: "task", agentName: "Фон", agentId: "bg", inputTokens: 5, outputTokens: 5 }),
  ];
  const day = seriesOf(rows.filter((r) => r.model === "pro"), {}, 0, Date.parse("2026-11-06T00:00:00.000Z"));
  assert.equal(day.points.reduce((s, p) => s + p.requests, 0), 1);
  const tasks = tasksOf(rows);
  assert.equal(tasks[0]?.sessionId, "s2");
  assert.equal(tasks[1]?.requests, 2);
  assert.equal(tasks[1]?.totalTokens, 12);
  const page = pageOf(rows, 1, 1);
  assert.equal(page.total, 3);
  assert.equal(page.items[0]?.id, "b");
  const facets = facetsOf(rows);
  assert.deepEqual(facets.models, ["deepseek-flash", "pro"]);
  assert.equal(facets.agents.length, 2);
});
