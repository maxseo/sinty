import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseClaims } from "./extract.js";
import { brightness, inRecall } from "./policy.js";
import { MemoryV1Store, rememberLine } from "./store.js";

function store(): MemoryV1Store {
  return new MemoryV1Store(join(mkdtempSync(join(tmpdir(), "mem-v1-")), "memory-v1.db"));
}

const base = { userId: "u1", agentId: "a1", sessionId: "s1", projectId: "p1", kind: "fact" as const, basis: "user_requested" as const, evidenceId: "m1", quote: "цитата" };

test("eval: another user cannot see or link claims", () => {
  const db = store();
  const saved = db.remember({ ...base, text: "Пользователь живёт в Казани", opKey: "op1" });
  assert.equal(db.search("u2", "a1", { sessionId: "s1", projectId: "p1" }, "Казани").length, 0);
  assert.equal(db.graph("u2", "a1", { sessionId: "s1" }).nodes.length, 0);
  assert.throws(() => db.remember({ ...base, userId: "u2", text: "связь", opKey: "op2", links: [{ to: saved.id, rel: "supports" }] }), /this user's memory/);
});

test("eval: the same operation does not create a second sphere", () => {
  const db = store();
  const first = db.remember({ ...base, text: "Срок сдачи — пятница", opKey: "op1" });
  const again = db.remember({ ...base, text: "Срок сдачи — пятница", opKey: "op1" });
  assert.equal(again.action, "replay");
  assert.equal(again.id, first.id);
  assert.equal(db.graph("u1", "a1", { sessionId: "s1", projectId: "p1" }).nodes.length, 1);
});

test("eval: a changed replay is rejected", () => {
  const db = store();
  db.remember({ ...base, text: "Срок сдачи — пятница", opKey: "op1" });
  assert.throws(() => db.remember({ ...base, text: "Срок сдачи — понедельник", opKey: "op1" }), /different input/);
});

test("eval: a secret is refused and nothing is stored", () => {
  const db = store();
  assert.throws(() => db.remember({ ...base, text: "api_key: sk-live-abcdef123456", opKey: "op1" }));
  assert.equal(db.graph("u1", "a1", { sessionId: "s1" }).nodes.length, 0);
});

test("eval: default policy hides other projects and keeps the user card", () => {
  const db = store();
  db.remember({ ...base, kind: "preference", text: "Пишет по-русски", opKey: "u", projectId: "p1" });
  db.remember({ ...base, kind: "decision", text: "В этом проекте берём sqlite", opKey: "d", sessionId: "s-other" });
  db.remember({ ...base, kind: "fact", text: "Чужой репозиторий на Go", opKey: "o", projectId: "p2", sessionId: "s2" });
  const here = { sessionId: "s-new", projectId: "p1" };
  const found = db.search("u1", "a1", here, "русски sqlite репозиторий");
  assert.deepEqual(found.map((row) => row.text).sort(), ["В этом проекте берём sqlite", "Пишет по-русски"]);
});

test("eval: chat-only mode keeps other chats out", () => {
  const db = store();
  db.setPolicy("u1", "a1", { mode: "chat", aboutUser: true, projectWork: true, otherProjects: false, night: false, researchAtNight: false, researchPrompt: "" });
  db.remember({ ...base, text: "Только этот разговор", opKey: "c1", sessionId: "s1" });
  assert.equal(db.search("u1", "a1", { sessionId: "s2", projectId: "p1" }, "разговор").length, 0);
  assert.equal(db.search("u1", "a1", { sessionId: "s1", projectId: "p1" }, "разговор").length, 1);
});

test("eval: a closed claim leaves search and stays on the graph", () => {
  const db = store();
  const saved = db.remember({ ...base, text: "Порт 8787", opKey: "c" });
  db.close("u1", "a1", saved.id, "close-1");
  assert.equal(db.search("u1", "a1", { sessionId: "s1", projectId: "p1" }, "8787").length, 0);
  const node = db.graph("u1", "a1", { sessionId: "s1", projectId: "p1" }).nodes[0];
  assert.equal(node?.validTo !== null, true);
  assert.equal(node?.inRecall, false);
});

test("eval: the same text is one card, and a new subject replaces the old truth", () => {
  const db = store();
  const first = db.remember({ ...base, text: "Пользователь живёт в Казани", subject: "user.city", opKey: "a" });
  const again = db.remember({ ...base, kind: "preference", text: "Пользователь живёт в Казани", opKey: "b" });
  assert.equal(again.id, first.id);
  const next = db.remember({ ...base, text: "Пользователь живёт в Перми", subject: "user.city", opKey: "c" });
  assert.notEqual(next.id, first.id);
  const cards = db.graph("u1", "a1", { sessionId: "s1", projectId: "p1" }).nodes;
  assert.equal(cards.find((card) => card.id === first.id)?.status, "past");
  assert.equal(cards.find((card) => card.id === next.id)?.status, "current");
  assert.ok(db.graph("u1", "a1", { sessionId: "s1", projectId: "p1" }).edges.some((edge) => edge.rel === "supersedes" && edge.from === first.id && edge.to === next.id));
  assert.equal(db.search("u1", "a1", { sessionId: "s1", projectId: "p1" }, "Казани").length, 0);
  assert.equal(db.search("u1", "a1", { sessionId: "s1", projectId: "p1" }, "раньше Казани").length, 1);
});

test("eval: an inferred card without the user's words is refused", () => {
  const db = store();
  assert.throws(() => db.remember({ ...base, basis: "agent_inferred", text: "Пользователь живёт в Казани", quote: "в Казани", sourceText: "привет", opKey: "q" }));
  assert.equal(db.graph("u1", "a1", { sessionId: "s1" }).nodes.length, 0);
});

test("eval: facts and preferences are in the block, decisions are long memory", () => {
  const db = store();
  db.remember({ ...base, kind: "preference", text: "Пишет по-русски", opKey: "u" });
  db.remember({ ...base, kind: "decision", text: "Берём sqlite", opKey: "d" });
  assert.deepEqual(db.prompt("u1", "a1").map((row) => row.text), ["Пишет по-русски"]);
  assert.equal(db.prompt("u1", "a1")[0]?.span, "near");
});
test("eval: a normal sentence can be parsed into a claim without the word запомни", () => {
  const claims = parseClaims('{"claims":[{"text":"Пользователя зовут Макс","quote":"меня зовут Макс","kind":"fact"},{"text":"привет","kind":"nope"}]}');
  assert.deepEqual(claims, [{ text: "Пользователя зовут Макс", kind: "fact", quote: "меня зовут Макс" }]);
  assert.deepEqual(parseClaims("не json"), []);
});

test("eval: запомни without a colon is a claim", () => {
  assert.equal(rememberLine("запомни меня зовут Макс"), "меня зовут Макс");
  assert.equal(rememberLine("запомни: срок в пятницу"), "срок в пятницу");
  assert.equal(rememberLine("просто разговор"), undefined);
});

test("eval: brightness fades and drops out of recall under 0.15", () => {
  assert.ok(brightness(1, new Date().toISOString()) > 0.9);
  const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
  assert.ok(brightness(0.6, old) < 0.15);
  const claim = { id: "mem_1", userId: "u", agentId: "a", sessionId: "s", projectId: "p", home: "project" as const, kind: "fact" as const, span: "near" as const, status: "current" as const, subject: "", text: "x", salience: 0.6, validTo: null, touchedAt: old };
  assert.equal(inRecall(claim, { sessionId: "s", projectId: "p" }, { mode: "project", aboutUser: true, projectWork: true, otherProjects: false, night: false, researchAtNight: false, researchPrompt: "" }), false);
});

test("eval: projectWork hides another chat's decision and keeps the project fact", () => {
  const db = store();
  db.setPolicy("u1", "a1", { mode: "project", aboutUser: true, projectWork: false, otherProjects: false, night: false, researchAtNight: false, researchPrompt: "" });
  db.remember({ ...base, kind: "fact", text: "Файл лежит в src", sessionId: "other", opKey: "f" });
  db.remember({ ...base, kind: "decision", text: "Берём sqlite", sessionId: "other", opKey: "d" });
  db.remember({ ...base, kind: "decision", text: "Пишем тест", sessionId: "s1", opKey: "here" });
  const here = { sessionId: "s1", projectId: "p1" };
  assert.equal(db.search("u1", "a1", here, "файл").length, 1);
  assert.equal(db.search("u1", "a1", here, "sqlite").length, 0);
  assert.equal(db.search("u1", "a1", here, "тест").length, 1);
});
