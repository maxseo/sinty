import assert from "node:assert/strict";
import test from "node:test";
import type { SintyEvent } from "@sinty/sdk";
import { applyJournalEvent, createFold, type FoldEffect } from "./fold.js";
import type { UsageCall } from "./types.js";

function ev(partial: Pick<SintyEvent, "type" | "data"> & { id?: string; seq?: number; ts?: string; stepId?: string; turnId?: string; actor?: SintyEvent["actor"] }): SintyEvent {
  return {
    id: partial.id ?? "e1",
    seq: partial.seq ?? 1,
    ts: partial.ts ?? "2026-11-05T12:00:00.000Z",
    sessionId: "ses",
    type: partial.type,
    actor: partial.actor ?? { kind: "system", id: "system" },
    data: partial.data,
    ...(partial.stepId ? { stepId: partial.stepId } : {}),
    ...(partial.turnId ? { turnId: partial.turnId } : {}),
  } as SintyEvent;
}

function callOf(effects: FoldEffect[]): UsageCall {
  const found = effects.find((e) => e.type === "call");
  if (!found || found.type !== "call") throw new Error("no call");
  return found.call;
}

test("a chat step keeps tokens, cache, duration and the stop reason", () => {
  const fold = createFold({ title: "Заметки" });
  applyJournalEvent(fold, ev({ type: "model.request", id: "r", seq: 1, ts: "2026-11-05T12:00:00.000Z", stepId: "s1", data: { route: "default", provider: "deepseek", model: "deepseek-flash", messagesHash: "ab", estTokens: 10 } }));
  applyJournalEvent(fold, ev({ type: "model.response", id: "m", seq: 2, ts: "2026-11-05T12:00:01.000Z", stepId: "s1", data: { text: "ok", toolCalls: [], stopReason: "stop", usage: { provider: "deepseek", model: "deepseek-flash", inputTokens: 1000, outputTokens: 5, cachedTokens: 900, cacheMissTokens: 100 } } }));
  const call = callOf(applyJournalEvent(fold, ev({
    type: "usage.recorded",
    id: "u",
    seq: 3,
    ts: "2026-11-05T12:00:01.200Z",
    stepId: "s1",
    turnId: "t1",
    data: { provider: "deepseek", model: "deepseek-flash", inputTokens: 1000, outputTokens: 5, cachedTokens: 900, cacheMissTokens: 100, cacheWriteTokens: 0 },
  })));
  assert.equal(call.durationMs, 1200);
  assert.equal(call.stopReason, "stop");
  assert.equal(call.sessionTitle, "Заметки");
  assert.equal(call.cachedTokens, 900);
  assert.equal(call.cacheMissTokens, 100);
  assert.equal(call.costUsd, null);
  assert.equal(call.source, "chat");
  assert.equal(call.route, "default");
});

test("message.agent names the turn, including calls that were already folded", () => {
  const fold = createFold();
  const call = callOf(applyJournalEvent(fold, ev({ type: "usage.recorded", id: "u", seq: 2, turnId: "t1", stepId: "s1", data: { provider: "deepseek", model: "m", inputTokens: 3, outputTokens: 1 } })));
  assert.equal(call.agentName, "");
  const named = applyJournalEvent(fold, ev({ type: "message.agent", id: "a", seq: 4, turnId: "t1", data: { text: "hi", agentId: "agt", agentName: "Макс" } as SintyEvent<"message.agent">["data"] }));
  assert.deepEqual(named, [{ type: "agent", sessionId: "ses", turnId: "t1", agentId: "agt", agentName: "Макс" }]);
  const later = callOf(applyJournalEvent(fold, ev({ type: "usage.recorded", id: "u2", seq: 5, turnId: "t1", stepId: "s2", data: { provider: "deepseek", model: "m", inputTokens: 4, outputTokens: 1 } })));
  assert.equal(later.agentName, "Макс");
});

test("plugin model calls take duration from models.called in either order and do not invent cost", () => {
  const first = createFold({ task: true });
  applyJournalEvent(first, ev({
    type: "models.called",
    id: "c",
    seq: 1,
    ts: "2026-11-05T12:00:00.000Z",
    actor: { kind: "plugin", id: "vision" },
    data: { plugin: "vision", op: "complete", route: "cheap", provider: "deepseek", model: "flash", inputTokens: 8, outputTokens: 2, ms: 640, ok: true },
  }));
  const call = callOf(applyJournalEvent(first, ev({
    type: "usage.recorded",
    id: "u",
    seq: 2,
    ts: "2026-11-05T12:00:00.400Z",
    actor: { kind: "plugin", id: "vision" },
    data: { provider: "deepseek", model: "flash", inputTokens: 8, outputTokens: 2 },
  })));
  assert.equal(call.durationMs, 640);
  assert.equal(call.source, "plugin");
  assert.equal(call.agentName, "vision");
  assert.equal(call.sessionKind, "task");
  assert.equal(call.costUsd, null);

  const second = createFold();
  applyJournalEvent(second, ev({
    type: "usage.recorded",
    id: "u",
    seq: 1,
    ts: "2026-11-05T12:00:00.400Z",
    data: { provider: "deepseek", model: "flash", inputTokens: 8, outputTokens: 2 },
  }));
  const patched = applyJournalEvent(second, ev({
    type: "models.called",
    id: "c",
    seq: 2,
    ts: "2026-11-05T12:00:00.000Z",
    data: { plugin: "vision", op: "complete", route: "cheap", provider: "deepseek", model: "flash", inputTokens: 8, outputTokens: 2, ms: 640, ok: true },
  }));
  assert.deepEqual(patched, [{ type: "duration", id: "u", durationMs: 640 }]);
});
