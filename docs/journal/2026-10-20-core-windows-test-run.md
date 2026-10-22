# Windows test run of the memory work (PR #1 + #2) and two Windows fixes

- Date: 2026-10-20
- Area: packages/core (shell.ts, __tests__/golden.test.ts)
- Plan step: release check before merging PR #1 (memory plan steps 0–6) and PR #2 (afterTurn drain)
- Commits: `a807ee9 fix(core): Windows test fixes — golden path normalization and ShellBox.exe lookup in a source checkout`; this entry: `docs(journal): Windows test run of PR #1 and #2`
- PR: [#3](https://github.com/maxseo/sinty/pull/3) (merge `6d65de2`)

## What and why

Until now the memory work had only been tested on Linux. Before merging, the full suite ran on Max's Windows
machine. It ran in a temporary `git worktree` of `fix/run-drain-memory-queue`, under `%TEMP%`, so the main
checkout was not touched.

Environment:
- Windows, Node 24.12.0;
- pnpm 10.18.0 through `corepack pnpm`, as `packageManager` in package.json pins it (pnpm is not installed globally there);
- a process-local `pnpm.cmd` shim, so the nested `pnpm -r` calls resolve.

First run: core had 83 tests, 79 pass, 4 fail.

1. `golden: memory block, memory tools and recall…` and `golden: compaction…`. The system prompt contains
   `Workspace folder: <HOME>\workspace`, but the snapshots were recorded on Linux with `/`. The prompt itself was
   correct; the test only normalized the home prefix, not the separators after it.
2. `shell stays in the workspace…` and `a command cannot read a file outside its workspace` failed with
   `command cage is missing`.
   - `shellBoxExe()` only looked for `dist/sandbox/ShellBox.exe`. That copy is made by `scripts/stage.mjs` for
     installs.
   - A fresh clone has only the tracked `packages/core/sandbox/ShellBox.exe`.
   - Max's own checkout passed only because an old staged copy was lying in `dist/`.

## Files touched

- `packages/core/src/__tests__/golden.test.ts`: `normalize()` rewrites `<HOME>\\a\\b` to `<HOME>/a/b` in the
  JSON text.
- `packages/core/src/shell.ts`: `shellBoxExe()` tries `dist/sandbox/ShellBox.exe`, then `../sandbox/ShellBox.exe`
  (the tracked binary next to `dist`).

## Results after the fix

- Windows: core 83/83 pass, 0 skipped. This includes the Windows-only shell sandbox tests, which are skipped on
  Linux. Supervisor 4/4.
- Windows smoke run:
  - isolated `SINTY_HOME` in `%TEMP%` and a fake OpenAI-compatible model on 127.0.0.1;
  - `sinty init`, then `sinty run` with `fact-extractor` and a `cheap` route;
  - exit 0, `memory_jobs` shows `done` with 1 attempt, the fact is stored, and there is no `memory is closed`
    warning.
- Linux: core 83 tests, 81 pass, 2 skipped (Windows-only); supervisor 4/4.

PR #1 and PR #2 were then merged into `main` with merge commits: `bb47710` and `83dc002`.

## Known limitations

- The golden snapshots compare Linux-style paths; any new path in the prompt must be under `<HOME>` to be normalized.
- `esbuild` build scripts are ignored by pnpm 10 (`pnpm approve-builds`); not needed for the tests.
