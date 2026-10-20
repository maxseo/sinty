# Recall: AND → OR → prefix fallback in full-text search

- Date: 2026-10-20
- Area: packages/core (memory.ts)
- Plan step: follow-up to memory plan step 2 (builtin store behind MemoryRouter); known limitation "FTS recall is AND-only"
- Commits: `feat(memory): recall OR/prefix fallback, journaled tool writes, sinty memory reindex` (one commit for the three memory changes, docs/spec/memory.md and CHANGELOG)

## What and why

`MemoryStore.ftsIds()` joined every query word with `AND`. A natural-language query such as "какой PR открыт по
памяти" found nothing: no fact contains "какой". `memory.recall` and automatic recall then fell back to a
whole-query substring scan, which also found nothing. Without an embed route, recall therefore only worked for
short keyword queries. Another inflection of a word ("память" vs "памяти", "deploying" vs "deploy") never matched.

Now `ftsIds()` runs up to three FTS5 queries and keeps the first 50 distinct fact ids, in this order:

1. AND of every word: lowercased, split on non-letter/digit, 2+ letters, at most 12, quotes removed (`ftsWords`).
2. OR of the words with 3+ letters.
3. OR of prefix queries `"stem"*`. `ftsStem(word)` cuts words longer than 5 letters by up to 3 letters and keeps
   at least 4: "памяти" → "памя", "deploying" → "deploy", "компакции" → "компак".

Each stage is `ORDER BY rank`, which is FTS5's bm25. A stage only appends ids that earlier stages did not return,
so full matches always rank above partial ones. The rest of `recall()` is unchanged:
- the visibility filter (user/agent/chat scope, expiry, no profile);
- RRF fusion with vector hits;
- age decay (90 days);
- the final substring scan when FTS and vectors both return nothing.

## Files touched

- `packages/core/src/memory.ts`: `ftsIds()` rewritten; new exported helpers `ftsWords()` and `ftsStem()`.
- `packages/core/src/__tests__/memory.test.ts`: test `memory: recall falls back from AND to OR and to word
  prefixes, AND hits first`.

## Design decisions

- The fallback is inside the builtin store, not in a plugin. It is how the core's own `memory.recall` ranks text,
  and plugins can already reorder or filter results through `afterRecall`.
- Stages instead of one OR query. A single OR query with bm25 can rank a fact that repeats one rare word above a
  fact that has every word. The AND stage keeps exact matches on top, which is what the agent expects.
- Two-letter words are kept for AND but dropped from OR and prefix. Otherwise "по", "is" or "to" would match most
  facts.
- A language-neutral stem instead of Snowball: no new dependency, and it works the same for Russian and English.
  It is deliberately conservative: at least 4 letters, at most 3 removed.

## Rejected alternatives

- FTS5 `trigram` tokenizer: it needs a schema migration of `facts_fts` and grows the index a lot.
- Snowball stemmers in JavaScript: an extra dependency and per-language config; noted in the backlog.

## Migration notes

None. The schema is unchanged, and existing `memory.db` files work as is.

## Known limitations

- Recall is broader than before. Auto recall (`memory.recall.auto`) can now add partial matches to the prompt. They
  are still capped by `memory.recall.limit` and `budgetTokens`, and the full matches come first.
- The stem is crude: it does not match "deployment" ↔ "deploy" (10 letters → "deployme") or irregular forms.
  Embeddings (`models.routes.embed` + `sinty memory reindex`) are the real fix for paraphrases.
- The candidate list is capped at 50 ids before the visibility filter, as before.

## How to test

- `node --test packages/core/dist/__tests__/memory.test.js`.
- Manually: write a log fact "20 октября открыт PR #1 по памяти.", then call `memory.recall` with
  "какой PR открыт по памяти" and with "память". Both return it.
