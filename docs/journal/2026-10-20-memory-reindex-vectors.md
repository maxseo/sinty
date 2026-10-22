# `sinty memory reindex`: backfill vectors for existing facts

- Date: 2026-10-20
- Area: packages/core (memory.ts, memory-router.ts), packages/cli
- Plan step: follow-up to memory plan step 5 (vector search); known limitation "no vector backfill command"
- Commits: `feat(memory): recall OR/prefix fallback, journaled tool writes, sinty memory reindex` (one commit for the three memory changes, docs/spec/memory.md and CHANGELOG)
- PR: [#3](https://github.com/maxseo/sinty/pull/3) (merge `6d65de2`)

## What and why

The builtin store embeds a fact only when it is written and `models.routes.embed` is configured. Facts written
before the embed route was set, or while it failed, never got a vector. Vector recall could not find them, and
nothing could repair it short of rewriting every fact.

The new command:

```
sinty memory reindex [--dry-run] [--batch 64] [--json]
```

calls `MemoryRouter.reindexVectors({ dryRun, batchSize, signal, onProgress })`:

1. Throws `vec_unavailable` when sqlite-vec is not loaded.
2. Counts live facts without a vector: `MemoryStore.countMissingVectors()`, i.e. `id NOT IN (SELECT fact_id FROM
   facts_vec)` and not expired. Dry run, or nothing to do: return `{ total, embedded: 0, dryRun }` without any
   model call.
3. Throws `embed_route` when no embed route is configured.
4. Loops:
   - `MemoryStore.missingVectors(batch)`, oldest first;
   - the router's embedder (`ModelGateway.embed` on the `embed` route);
   - checks the vector count and that the width equals `memory.dimensions`;
   - `MemoryStore.setVector(id, v)`, which skips facts deleted meanwhile;
   - reports progress `{ done, total }`.

   The loop stops when no rows are left or after `total` facts.

The CLI prints `embedded N/M` to stderr (one updating line on a TTY) and a summary on stdout, or JSON with
`--json`. It exits 1 on error or when not everything was embedded. Rerunning is safe: only missing facts are sent.

Also in this change: `MemoryRouter.drainBeforeClose()` (from PR #2) now waits only for a drain that is already
running and no longer starts one. Before, a one-shot command (`sinty memory eval`, `sinty memory reindex`) began
processing old pending afterTurn jobs on its way out, which costs model calls for no reason. `sinty run` is
unaffected: its turn starts the drain.

## Files touched

- `packages/core/src/memory.ts`: `countMissingVectors()`, `missingVectors(limit)`, `setVector(id, embedding)`.
- `packages/core/src/memory-router.ts`: `reindexVectors()`; the `drainBeforeClose()` guard.
- `packages/cli/src/bin.ts`: `memory reindex` subcommand, the `--dry-run` and `--batch` options, help text.
- Tests:
  - `packages/core/src/__tests__/memory.test.ts`: `memory: vector backfill helpers list only live facts without a
    vector`;
  - `packages/core/src/__tests__/memory-router.test.ts`: `router: reindexVectors embeds facts that have no vector,
    in batches, idempotently`. Facts are written without an embed route, then after a restart with the fake embed
    route of `recording-provider`:
    - dry run → total 3, no embed call;
    - batch 2 → progress `2/3`, `3/3`, two embed calls;
    - rerun → no-op;
    - a query with no word overlap is then found by vector.

## Design decisions

- In the core and not a plugin: the vectors live in the builtin `facts_vec` table, which is core-owned (sqlite-vec
  runs in the core process). The embedding goes through the same `ModelGateway` route and secrets as normal writes.
- Errors are thrown, not turned into `memory.degraded`. A command must say why it did not finish; vectors stored
  before the error remain.
- Batch size is capped at 512 to stay under typical provider input limits.

## Rejected alternatives

Not recorded when the change was made (noted in the 2026-10-22 docs audit, [#19](https://github.com/maxseo/sinty/pull/19)).

## Migration notes

None. Run `sinty memory reindex --dry-run` once after setting `models.routes.embed` to see how many facts need it.

## Known limitations

- Vectors of facts whose text changed are refreshed only on the next write of that fact (as before).
- Changing `memory.dimensions` still needs a new `memory.db`: reindex cannot change the `facts_vec` width.
- No rate limiting between batches beyond what the provider enforces.

## How to test

- `node --test packages/core/dist/__tests__/memory-router.test.js packages/core/dist/__tests__/memory.test.js`.
- Manual, verified on Linux with a fake OpenAI-compatible `/embeddings`:
  - 5 facts written, no embed route → `reindex failed: models.routes.embed is not set`, exit 1;
  - with the route → `--dry-run` reports 5;
  - `--batch 2` prints `embedded 2/5`, `4/5`, `5/5`;
  - a rerun with `--json` → `{"total":0,"embedded":0,"dryRun":false}`.
