import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryV1Store, looksSecret, rememberLine } from "./store.js";

function store(): MemoryV1Store {
  return new MemoryV1Store(join(mkdtempSync(join(tmpdir(), "mem-baskets-")), "memory-v1.db"));
}

const here = { sessionId: "s1", projectId: "p1" };
const base = { userId: "u1", agentId: "a1", sessionId: "s1", projectId: "p1", kind: "fact" as const, basis: "user_requested" as const, evidenceId: "m1", quote: "цитата" };

test("B2 explicit remember keeps the body, not the word запомни", () => {
  const db = store();
  const body = rememberLine("запомни меня зовут Макс");
  assert.equal(body, "меня зовут Макс");
  db.remember({ ...base, text: body!, quote: body!, opKey: "r03" });
  const card = db.prompt("u1", "a1")[0];
  assert.equal(card?.text, "меня зовут Макс");
  assert.equal(card?.span, "near");
  assert.equal(card?.home, "project");
});

test("B4 decisions stay out of the prompt and show up only in search", () => {
  const db = store();
  db.remember({ ...base, kind: "preference", text: "Пиши коротко", opKey: "p" });
  db.remember({ ...base, kind: "decision", text: "В этом проекте берём sqlite", opKey: "d" });
  db.remember({ ...base, kind: "question", text: "Порт наружу не выбран", opKey: "q" });
  const prompt = db.prompt("u1", "a1").map((card) => card.text);
  assert.deepEqual(prompt, ["Пиши коротко"]);
  assert.equal(db.search("u1", "a1", here, "порт").some((card) => card.kind === "question"), true);
  assert.equal(db.search("u1", "a1", here, "расскажи анекдот").length, 0);
});

test("B5 a secret never becomes a card", () => {
  const db = store();
  assert.equal(looksSecret("api_key: sk-live-abcdef123456"), true);
  assert.equal(rememberLine("запомни ключ api_key: sk-live-abcdef123456"), undefined);
  assert.throws(() => db.remember({ ...base, text: "api_key: sk-live-abcdef123456", opKey: "sec" }));
  assert.equal(db.graph("u1", "a1", here).nodes.length, 0);
});

test("B6 the same sentence is one card even when the kind differs", () => {
  const db = store();
  const first = db.remember({ ...base, text: "Меня зовут Макс", opKey: "a" });
  const second = db.remember({ ...base, kind: "person", basis: "agent_inferred", text: "Меня зовут Макс", opKey: "b" });
  assert.equal(second.id, first.id);
  assert.equal(db.graph("u1", "a1", here).nodes.length, 1);
  assert.equal(db.graph("u1", "a1", here).nodes[0]?.salience, 1);
});

test("B7 a new card with the same subject sends the old one to the past", () => {
  const db = store();
  db.remember({ ...base, text: "Пользователь живёт в Казани", subject: "user.city", opKey: "old" });
  db.remember({ ...base, text: "Пользователь живёт в Перми", subject: "user.city", opKey: "new" });
  assert.equal(db.search("u1", "a1", here, "где я живу").map((card) => card.text).join(), "");
  const past = db.search("u1", "a1", here, "раньше Казани");
  assert.equal(past.length, 1);
  assert.equal(past[0]?.status, "past");
  assert.equal(db.prompt("u1", "a1").map((card) => card.text).join(" "), "Пользователь живёт в Перми");
});

test("B8 accounts, agents, projects and chat mode stay apart", () => {
  const db = store();
  db.remember({ ...base, kind: "person", text: "Пользователя зовут Макс", subject: "user.name", opKey: "name" });
  db.remember({ ...base, kind: "decision", text: "В этом проекте берём sqlite", opKey: "db" });
  assert.equal(db.graph("u2", "a1", here).nodes.length, 0);
  assert.equal(db.search("u1", "a2", here, "зовут").length, 0);
  assert.equal(db.search("u1", "a1", { sessionId: "s9", projectId: "p2" }, "sqlite").length, 0);
  assert.equal(db.search("u1", "a1", { sessionId: "s9", projectId: "p2" }, "зовут").length, 1);
  db.setPolicy("u1", "a1", { mode: "chat", aboutUser: true, projectWork: true, otherProjects: false, night: false, researchAtNight: false, researchPrompt: "" });
  assert.equal(db.search("u1", "a1", { sessionId: "s9", projectId: "p1" }, "sqlite").length, 0);
  assert.equal(db.search("u1", "a1", { sessionId: "s9", projectId: "p1" }, "зовут").length, 1);
});
