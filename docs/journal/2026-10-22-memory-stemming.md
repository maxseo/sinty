# Stemming for memory recall (Russian Snowball + English porter)

- Date: 2026-10-22
- Area: packages/core (stem.ts, memory.ts), docs
- Plan step: queue after step 7 (`/workspace/sinty-memory-plan.md` section 12: "стемминг для recall")
- Commits: `feat(memory): stemmed full-text recall for Russian and English word forms`

## What and why

Builtin recall had three FTS5 stages on the raw text (AND, OR, crude prefix). The prefix stage (`ftsStem`: words
over 5 letters lose up to 3 letters) only helps when the query word is long and the fact's form starts the same.
Short words never matched another form ("столы" did not find "стол", "новые" did not find "новый"), and a fact that
had every query word in another form ranked no higher than a fact with one of them verbatim. English had the same
gap ("cats runs" vs "cat ... running").

## Files touched

- `packages/core/src/stem.ts` (new): `stemRussian()` (Snowball Russian, snowballstem.org/algorithms/russian:
  RV/R1/R2 regions, perfective gerund, reflexive, adjectival with participle, verb, noun, `и`, derivational `ость`
  in R2, `нн` / superlative / `ь`), `stemText()`, `words()`, `STEM_VERSION`.
- `packages/core/src/memory.ts`: table `facts_stem` (FTS5 with the porter tokenizer), `rebuildStemsIfStale()` on
  open, `syncFts()` and `deleteId()` keep it in step, `ftsIds()` has the two stem stages.
- Tests: `src/__tests__/stem.test.ts`; fixture `test-fixtures/stem-ru.json` (436 words and their stems).
- Docs: `docs/spec/memory.md` ("Full-text recall").

## Design decisions

- **Snowball Russian written out, no dependency.** ~100 lines. It was checked against the reference implementation
  (`snowballstemmer` 2.x, Python, generated from the Snowball sources) on every distinct Russian word in the repo
  and the plan (1,742 words): 0 differences. A quarter of them is the test fixture.
- **English by SQLite.** FTS5's `porter` tokenizer stems English and passes Cyrillic through, so one table serves both
  languages: Russian words are stemmed before they are stored, English when they are tokenized. Query words take the
  same path.
- **Separate table, raw stages first.** An exact AND still ranks above a stemmed AND; stems sit between the exact and
  the partial stages. The crude prefix stays last: Snowball keeps some forms apart ("память" → `памя`, "памяти" →
  `памят`), and the prefix stage still joins them.
- **Index rebuild instead of a migration step.** `facts_stem` is derived from `memory_facts`; a version key decides
  when to rebuild, so a future stemmer change only bumps `STEM_VERSION`.

## Rejected alternatives

- A custom FTS5 tokenizer in C or through an extension: not loadable from `node:sqlite` without a native build.
- An npm stemmer (`snowball-stemmers`, `natural`): a dependency for 100 lines of a stable algorithm.
- Replacing the raw `facts_fts` with the stemmed table: exact matches would lose their rank above other forms.

## Migration notes

- The first open of an existing `memory.db` builds `facts_stem` for every fact in one transaction (milliseconds for
  thousands of facts) and stores `fts.stem`. Nothing else changes; downgrading leaves an unused table behind.

## Known limitations

- No stop-word list: very common short words ("по", "на") still count in the AND stages, as before.
- Mixed-script words (e.g. "PRы") are left unstemmed.
- Plugin memory providers (e.g. Obsidian) do their own search; this only changes the builtin store.

## How to test

- `node --test dist/__tests__/stem.test.js` in packages/core; full suite as usual.
