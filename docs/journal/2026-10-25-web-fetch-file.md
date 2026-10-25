# web.fetch_file — download URL into project workspace

- Date: 2026-10-25
- Area: plugins/tool-web, packages/core tests
- Plan step: Max — ближайшие пункты плана; after MCP п.3/п.4, next was web.fetch_file (journals marked it follow-up after #25 chroot)
- Commits: this commit
- PR: (open)

## Why

Project chats already chroot `fs.*`, `shell.run`, and screenshots into `workspace/projects/<slug>` (#25). Agents still had no way to save an arbitrary public URL as a binary/file there — only Markdown via `web.read` or a PNG screenshot. Journals after #25 listed `web.fetch_file` + ask/size limits as the explicit follow-up.

## What changed

- New tool `web.fetch_file { url, path, headers? }` in `tool-web`: `ctx.net.public.fetch` **without** `truncate`, write body under `run.workspace` (project dir or global).
- Path resolution mirrors tool-fs chroot (`resolveDestPath`); `skills:` and `../` escape → `outside_workspace`.
- Default policy **ask** (`sideEffects: external`, manifest `defaultPolicy: ask`).
- Size: `maxFetchMb` (default 20, clamp 1–20) → `maxFetchBytes`; over limit → `too_large` with download-specific hint.
- Optional headers sanitized (no Host / Content-Length / hop-by-hop; CR/LF stripped).
- Settings field + README; tests for happy path, project vs global, escape, too_large.

## Golden prompts

Adding `web.fetch_file` changes the tool list offered to the model. Regenerated `packages/core/src/__tests__/golden/{memory-tools,compaction}.json` with `UPDATE_GOLDEN=1` (only `web__fetch_file` added to tool name lists).

## Out of scope

- Scheduler / MCP curated (separate PRs).
- Changing batch-approve (#24) or chroot itself.

## Retest on PC

- `pnpm --filter @sinty/plugin-tool-web test` and core `tool-web` / `project-workspace` tests.
- After install: in a project chat, approve `web.fetch_file` once; confirm file lands under `workspace/projects/<slug>/…`, not global `_out`.
