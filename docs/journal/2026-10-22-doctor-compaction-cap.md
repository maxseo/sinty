# 2026-10-22 — `sinty doctor` reports the capped compaction point

## What and why

After the compaction cap (PR #14, `memory.compactCapTokens`, default 150000) was merged, `sinty doctor` on Max's
machine printed `context window deepseek/deepseek-v4-pro: 1048576 tokens (provider), summary at 681574`. The doctor
computed `tokens × 0.65` itself, so it ignored the cap; the memory router folds at 150000 there. Only the report was
wrong, not compaction.

## Files touched

- `packages/core/src/context-window.ts`: `describeCompaction(route, window, config)` builds the doctor line from
  `compactPoint(window, compactCap(config))`, the function the memory router and the Контекст snapshot use.
- `packages/core/src/index.ts`: exports `describeCompaction`, `compactCap`, `compactPoint`, `DEFAULT_COMPACT_CAP`.
- `packages/cli/src/bin.ts`: the doctor prints that line.
- `packages/core/src/__tests__/doctor-compaction.test.ts` (new, 3 tests), `CHANGELOG.md`.

## Design decisions

- The line lives in the core, next to `compactPoint()`, so the CLI holds no copy of the math and the wording can be
  tested where the tests run (the CLI package has no test runner).
- The line names the threshold that applies: `(memory.compactCapTokens; 65% of the window would be N)`, or
  `(65% of the window; memory.compactCapTokens N is higher)`, or `(65% of the window; no memory.compactCapTokens cap)`
  for `0` / `null`.
- A third test reads `bin.ts` and checks that the doctor calls `describeCompaction` and does no `0.65` math, so the
  wiring cannot silently drift again.

## How to test

- `corepack pnpm -r run test` (also with `TZ=UTC`). On the previous main (1ffa739) the new test file fails: the
  export is missing and the doctor still computes `summary at ${…0.65}`.
- `sinty doctor` with DeepSeek: `summary at 150000 (memory.compactCapTokens; 65% of the window would be 681574)`.
