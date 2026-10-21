import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../memory.js";
import { stemRussian, stemText } from "../stem.js";

/** Stemming for memory recall (docs/journal/2026-10-22-memory-stemming.md). */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test-fixtures", "stem-ru.json");

test("stem: Russian matches the Snowball reference (snowballstemmer, snowballstem.org) word for word", () => {
  const ref = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, string>;
  const wrong = Object.entries(ref).filter(([w, want]) => stemRussian(w) !== want);
  assert.deepEqual(wrong.map(([w, want]) => `${w}: ${stemRussian(w)} != ${want}`), []);
  assert.ok(Object.keys(ref).length > 400);
  // The cases that drove the rules: gerund after а, superlative, ё, reflexive verb, the soft sign.
  for (const [w, want] of [["делавшись", "дела"], ["красивейший", "красив"], ["ёлки", "елк"], ["деплоить", "депло"], ["сводку", "сводк"], ["сводка", "сводк"], ["компакции", "компакц"], ["компакция", "компакц"], ["памяти", "памят"], ["память", "памя"]] as const) {
    assert.equal(stemRussian(w), want, w);
  }
  assert.equal(stemRussian("deploy"), "deploy", "non-Cyrillic words pass through");
  assert.equal(stemText("Сводку по PR-12 deployed, обновления!"), "сводк по pr 12 deployed обновлен");
});

function open(file = join(mkdtempSync(join(tmpdir(), "sinty-stem-")), "memory.db")): MemoryStore {
  return new MemoryStore(file, { userId: "local", agentId: "Sinty", dimensions: 4 });
}

const fact = (store: MemoryStore, text: string) => store.write({ text, tier: "log", scope: "user", about: "work", source: "chat" }).id;

test("stem: recall finds other word forms in Russian and English before partial matches", () => {
  const store = open();
  const table = fact(store, "Купил новый стол для кабинета");
  const books = fact(store, "Новые книги лежат на полке");
  const cat = fact(store, "The cat keeps running around the house");
  const ids = (q: string) => store.recall({ query: q, chatId: "" }).map((f) => f.id);
  // Old code: "столы" and "новые" are 5 letters, too short for the crude prefix, so only the fact with the exact
  // word "новые" was found and the table fact was missing.
  assert.deepEqual(ids("столы новые"), [table, books], "every word in another form first, then the partial match");
  assert.deepEqual(ids("столом"), [table]);
  // English through the porter tokenizer: "cats runs" never matched "cat ... running" before.
  assert.deepEqual(ids("cats runs"), [cat]);
  store.close();
});

test("stem: an existing memory.db gets facts_stem built on open, and rebuilt when the stem version changes", () => {
  const file = join(mkdtempSync(join(tmpdir(), "sinty-stem-")), "memory.db");
  const first = open(file);
  const id = fact(first, "Пользователь предпочитает короткие ответы");
  first.close();
  // What an older core left behind: no facts_stem and no version.
  const raw = new DatabaseSync(file);
  raw.exec("DROP TABLE facts_stem; DELETE FROM memory_meta WHERE key = 'fts.stem'");
  raw.close();
  const again = open(file);
  assert.deepEqual(again.recall({ query: "предпочитал коротких ответов", chatId: "" }).map((f) => f.id), [id], "built for facts written before");
  again.close();
  // A stale version: rebuilt from memory_facts, not appended to.
  const old = new DatabaseSync(file);
  old.exec("UPDATE memory_meta SET value = 'old' WHERE key = 'fts.stem'; INSERT INTO facts_stem (stems, fact_id) VALUES ('мусор', 'ghost')");
  old.close();
  const third = open(file);
  third.close();
  const check = new DatabaseSync(file);
  const rows = check.prepare("SELECT fact_id FROM facts_stem").all() as { fact_id: string }[];
  const version = check.prepare("SELECT value FROM memory_meta WHERE key = 'fts.stem'").get() as { value: string };
  check.close();
  assert.deepEqual(rows.map((r) => r.fact_id), [id]);
  assert.notEqual(version.value, "old");
});

test("stem: forgetting a fact removes its stems", () => {
  const store = open();
  const id = fact(store, "Сервер перезапускается по ночам");
  assert.equal(store.forget({ id }), 1);
  assert.deepEqual(store.recall({ query: "серверы перезапускаются", chatId: "" }), []);
  store.close();
});
