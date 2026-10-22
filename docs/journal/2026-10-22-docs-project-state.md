# Project state docs for handoff

- Date: 2026-10-22
- Area: docs (plan, README, roadmap, backlog, journal), README.md, README.ru.md, CHANGELOG
- Plan step: after the queue of [plan](../plan.md) section 5; approved by Max as a docs-only PR so that a coding
  agent can pick up the project from the repository alone
- Commits: `docs: project state for handoff (plan, roadmap, backlog, journal index)`
- PR: [#19](https://github.com/maxseo/sinty/pull/19)

## What and why

The plan behind PR #1–#18 and the prompt-cache report lived outside the repository, the roadmap and backlog still
listed finished work as planned, and the journal had no index. Someone starting from a clone could not tell what was
decided, what is done and what is open. This change puts that state into the repository:

- `docs/plan.md` — the plan, cleaned up: the pre-refactor analysis (marked as historical), options A/B/C and why B,
  what stays in the core, the contract as implemented and how it differs from the original sketch, migration steps
  0–7 and the follow-up queue with final status and PR numbers, the outcome of the prompt-cache report.
- `docs/roadmap.md` — a "Done after 1.0 (October 2026)" table (change, PR, journal) and updated known gaps.
- `docs/backlog.md` — a "Done" list for `tool-web`, `skills`, the Linux shell sandbox, context window and cap,
  re-embed, stemming, token rotation and the SecurityWarning fix; new open items collected from the journal entries'
  limitations (see below); the money-based compaction cap (variant 2) merged into "Budgets in USD".
- `docs/README.md` — docs index and «Как подхватить проект»: reading order and the working rules.
- `docs/journal/README.md` — an index (date, entry, PR, one line) in date order; the entry format gains a `PR:` line.

## Audit of the history

Every merged PR #1–#18 already changed `CHANGELOG.md` and added at least one journal entry; no PR was missing
either. Gaps found and fixed in the entries:

- `2026-10-22-doctor-compaction-cap.md` had no header list (Date, Area, Plan step, Commits) and no Rejected
  alternatives, Migration notes or Known limitations; added.
- "Commits: this commit" in five entries (#9, #10, #15, #16, #17) is replaced by the real hashes; the PR #4 merge
  entry names `42d8378` and `24ba03f`.
- Every entry gains `- PR: #N (merge <hash>)`.
- References to files that exist only on a build machine (the plan and report files, two screenshots, an env script)
  and to an "overnight item N" task list are replaced by links to `docs/plan.md` or removed.
- Missing headings: `fix-run-drain-memory-queue` gets Migration notes (none; one new optional key); four entries get
  a heading saying the section was not recorded at the time, instead of inventing it after the fact.
- `login-token-rotation` and `linux-shell-sandbox` said "not tested on Windows"; an update line records the later
  full Windows run on `277db15`.
- `2026-10-20-core-windows-test-run.md` is a test report and keeps its own headings.

Decisions in the entries are not changed; only references, headers and missing sections.

## Files touched

- `docs/plan.md`, `docs/README.md`, `docs/journal/2026-10-22-docs-project-state.md` (new)
- `docs/roadmap.md`, `docs/backlog.md`, `docs/journal/README.md`, 31 journal entries (headers and references)
- `README.md`, `README.ru.md` (links in the Documentation list), `CHANGELOG.md`

## Design decisions

- `plan.md` is in Russian, like the plan it comes from; the rest of `docs/` stays English. The handoff section is
  Russian as requested; its links point to English specs.
- The contract section points to `packages/sdk/src/memory.ts` and `docs/spec/memory.md` as the source of truth and
  lists where the code differs from the original sketch, instead of copying the sketch.
- Open items come from the journal's Known limitations, so each one has a source entry.

## Rejected alternatives

- Committing the original plan and report files as they were: they contain machine-specific paths, line numbers of
  code that was rewritten, and notes about one user's install.
- Rewriting older journal entries to the full format: the missing reasoning would be invented after the fact.
- Editing `AGENTS.md`: the handoff section links to it and lives in `docs/README.md`.

## Migration notes

None. Documentation only; no code, config or schema change.

## Known limitations

- The test counts and the Windows result in `docs/README.md` are a snapshot of 2026-10-22 and age with the code.
- The journal index is maintained by hand; a new entry must add its row.

## How to test

- `pnpm install --frozen-lockfile && pnpm build && pnpm test && TZ=UTC pnpm test && pnpm typecheck` — nothing reads
  these docs, the suite must stay green.
- Links: every row of the journal index points to an existing file (checked with a script while writing).
