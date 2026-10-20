# Merging PR #3 (memory limitations) and PR #4 (context inspector) into main

- Date: 2026-10-20
- Area: repository, CHANGELOG, packages/core (memory-router)
- Plan step: release of the memory fixes and the context inspector
- Commits: PR #3 merge `6d65de2`; this commit (main merged into `feat/context-inspector`); the PR #4 merge commit

## What and why

The branches were developed in parallel from `83dc002`:
- PR #3 (`fix/memory-limitations`): FTS recall AND → OR → prefix, `sinty memory reindex`, `memory.written` for tool
  writes, and the persistent plugin token budget.
- PR #4 (`feat/context-inspector`): context snapshots, `ui.tabs` with `placement`, and the context-inspector plugin.

PR #3 was merged first with a merge commit, as with #1 and #2. Then `origin/main` was merged into
`feat/context-inspector` so that PR #4 merges cleanly and is tested as the final tree.

## Files touched

- `CHANGELOG.md`: the only textual conflict. Both branches added lines to the top of `### Added` under
  `[Unreleased]`. Both are kept: the `sinty memory reindex` entry first, then the context snapshot, `ui.tabs`,
  context-inspector and `placement` entries. The `### Changed` lines from #3 merged without conflict.
- `packages/core/src/memory-router.ts`: merged automatically. Checked by hand that both sides are present:
  - from #4, the `trace` parameter through `contextMessages` → `recallForTurn` → `plan` / `runPlan`, and the
    `beforeContext`, `afterRecall` and `onTurnStart` hook traces;
  - from #3, `write(…, { journal: true })` on the tool path and for summary and processor writes,
    `drainBeforeClose`, and `reindexVectors`.
  - The two touch different functions, except `contextMessages`/`recallForTurn`, where #3 did not change the
    signatures.

## Design decisions

- The branch was updated with a merge, not a rebase: PR #4 was already reviewed at `efb175c`, and a merge keeps
  those SHAs.
- Snapshots and the new `memory.written` events for tool writes do not interact. A snapshot is taken before the
  provider call; the event is journaled when the tool runs. The context-inspect tests do not count journal events.

## Rejected alternatives

- Squash merges: #1 and #2 used merge commits, and the journal entries cite the branch commits.

## Migration notes

None beyond those of #3 and #4. The new `plugin_model_usage` table in `journal.db` is created on first start.

## Known limitations

Those listed in the #3 and #4 entries: `2026-10-20-memory-recall-or-prefix-fallback.md`,
`2026-10-20-memory-reindex-vectors.md`, `2026-10-20-memory-tool-writes-journaled.md`,
`2026-10-20-models-persistent-plugin-budget.md` and `2026-10-20-ui-session-tabs-context-in-chat-header.md`.

## How to test

`pnpm build && pnpm typecheck && pnpm test` on the merged tree, on Linux and on Windows (temp worktree, corepack
pnpm, a shell without `SINTY_INSTALL_ROOT`). Run it on the merged tree, not on either branch alone.
