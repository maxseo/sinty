import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextSnapshot } from "@sinty/sdk";
import { TAB_CSP, TAB_HTML } from "./page.js";
import { SnapshotStore, summarize } from "./store.js";

function snap(id: string, sessionId = "ses_a", turnId = "trn_1", step = 1, text = "hello"): ContextSnapshot {
  return {
    version: 1,
    id,
    sessionId,
    turnId,
    stepId: id,
    step,
    at: new Date(Date.UTC(2026, 9, 20, 10, 0, Number(id.replace(/\D/g, "")) || 0)).toISOString(),
    agentId: "Sinty",
    route: "rec/main",
    messages: [{ role: "system", content: "sys" }, { role: "user", content: text }],
    parts: [
      { index: 0, kind: "system", source: "core", id: "system", role: "system", tokens: 8 },
      { index: 1, kind: "dialogue", source: "journal", role: "user", tokens: 9 },
    ],
    tools: [{ name: "memory.recall", tokens: 40 }],
    tokens: { total: 57, messages: 17, tools: 40, byKind: { system: 8, dialogue: 9 } },
    memory: { facts: [], hooks: [], recall: { queries: ["q"], records: [{ id: "f1", provider: "builtin:sqlite", text: "x" }], tokens: 3, cached: false } },
    contexts: [],
    redactions: 0,
  };
}

test("store keeps the newest snapshots by count", () => {
  const s = new SnapshotStore(2, 1e9);
  s.add(snap("s1"));
  s.add(snap("s2"));
  s.add(snap("s3"));
  assert.equal(s.size, 2);
  assert.equal(s.get("s1"), undefined);
  assert.deepEqual(s.list().map((x) => x.id), ["s2", "s3"]);
});

test("store keeps the newest snapshots by size and skips one that is too big alone", () => {
  const one = JSON.stringify(snap("s1")).length;
  const s = new SnapshotStore(100, one * 2 + 10);
  s.add(snap("s1"));
  s.add(snap("s2"));
  s.add(snap("s3"));
  assert.deepEqual(s.list().map((x) => x.id), ["s2", "s3"]);
  s.add(snap("s4", "ses_a", "trn_1", 1, "x".repeat(one * 3)));
  assert.equal(s.get("s4"), undefined);
});

test("store groups sessions and turns, newest session first; list filters by session", () => {
  const s = new SnapshotStore(10, 1e9);
  s.add(snap("s1", "ses_a", "trn_1", 1));
  s.add(snap("s2", "ses_a", "trn_1", 2));
  s.add(snap("s3", "ses_b", "trn_2", 1));
  s.add(snap("s4", "ses_a", "trn_3", 1));
  const sessions = s.sessions();
  assert.deepEqual(sessions.map((x) => [x.sessionId, x.turns, x.steps]), [["ses_a", 2, 3], ["ses_b", 1, 1]]);
  assert.deepEqual(s.list("ses_b").map((x) => x.id), ["s3"]);
});

test("a re-sent snapshot id replaces the old one", () => {
  const s = new SnapshotStore(10, 1e9);
  s.add(snap("s1", "ses_a", "trn_1", 1, "old"));
  s.add(snap("s1", "ses_a", "trn_1", 1, "new"));
  assert.equal(s.size, 1);
  assert.equal(s.get("s1")!.messages[1]!.content, "new");
});

test("summary carries counts, not prompt text", () => {
  const sum = summarize(snap("s1"));
  assert.equal(sum.messages, 2);
  assert.equal(sum.recalled, 1);
  assert.equal(JSON.stringify(sum).includes("hello"), false);
});

test("tab page: no network in its CSP, data only through the tab/1 bridge, rendered as text", () => {
  assert.match(TAB_CSP, /default-src 'none'/);
  assert.match(TAB_CSP, /connect-src 'none'/);
  assert.doesNotMatch(TAB_CSP, /'self'|https?:/);
  assert.match(TAB_HTML, /parent\.postMessage\(\{ sinty: PROTO, id: id, op: "get", path: path \}, "\*"\)/);
  assert.match(TAB_HTML, /if \(e\.source !== parent\) return;/);
  assert.doesNotMatch(TAB_HTML, /innerHTML|fetch\(|XMLHttpRequest|eval\(/);
  // Session tab: no session picker of its own; the chat comes from the bridge.
  assert.doesNotMatch(TAB_HTML, /id="session"/);
  assert.match(TAB_HTML, /m\.op === "session"/);
});

test("store: real usage (usage.recorded) joins the step summary by stepId, with the core's cache estimates", () => {
  const s = new SnapshotStore(10, 1e9);
  const a = snap("u1");
  a.cache = { hints: [{ index: 0, hint: "static" }], cacheable: { messages: 1, tokens: 48 }, reused: { messages: 1, tokens: 48, toolsSame: true, divergedAt: 1 } };
  s.add(a);
  assert.equal(s.list()[0]!.usage, undefined, "no usage until the model call finished");
  assert.deepEqual(s.list()[0]!.cache, { cacheable: 48, reused: 48 });
  s.addUsage("u1", { provider: "deepseek", model: "v4", inputTokens: 1000, outputTokens: 20, cachedTokens: 900, cacheMissTokens: 100, costUsd: 1 });
  assert.deepEqual(s.list()[0]!.usage, { provider: "deepseek", model: "v4", inputTokens: 1000, outputTokens: 20, cachedTokens: 900, cacheMissTokens: 100 });
  assert.equal(s.usageOf("u1")?.cachedTokens, 900);
  // Bounded: at most twice `keep` usage entries.
  for (let i = 0; i < 30; i++) s.addUsage(`x${i}`, { provider: "p", model: "m", inputTokens: 1, outputTokens: 1 });
  assert.equal(s.usageOf("u1"), undefined);
});
