# Change journal

This folder records **why** the code changed, not only what changed. It is written to be fed to
bots and LLMs (and humans) that need the reasoning behind the current design before they touch it.
Git history says *what*; these entries say *why*, *what else was considered* and *what is still missing*.

## How to use it

- Read the entries for the area you are about to change, newest last. Each entry is self-contained.
- When a design decision here is reversed, write a new entry that links the old one; do not rewrite history.
- Keep `CHANGELOG.md` (user-facing, Keep a Changelog) and this journal (engineering reasoning) in sync:
  every entry ends up as one or more CHANGELOG lines.

## File naming

`YYYY-MM-DD-<area>-<short-slug>.md`, for example `2026-10-19-memory-step-0-cleanup.md`.
Several entries per day are fine; the slug orders them.

## Entry format

Every entry uses the same headings so a model can find sections by name:

```markdown
# <Title>

- Date: YYYY-MM-DD
- Area: <package / subsystem>
- Plan step: <reference to the plan, if any>
- Commits: <short hashes or "this commit">

## What and why
## Files touched
## Design decisions
## Rejected alternatives
## Migration notes
## Known limitations
## How to test
```

Write plain, specific sentences. Name files, functions, config keys and event types exactly as they appear in
code. State limitations honestly; an entry that hides a gap is worse than no entry.
