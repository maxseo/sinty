# UX status line, streaming prefs, project workspace chroot

- Date: 2026-10-23
- Area: apps/web (chat, settings, CSS), packages/sdk (ToolRunContext), packages/core (agent CallCtx workspace, shell, pathVerdict), plugins/tool-fs, plugins/tool-web
- Plan step: Max chose pack `ux_plus_chroot` after review of PR #24 reinstall (live status contrast, streaming toggle, project vs `_out`)
- Commits: this commit
- PR: (open)

## What and why

After #24 the live «Фон» line used a pill + shimmer that painted `color: transparent` from `currentColor`, so light theme showed white-on-white. Thinking («агент думает») was also hidden whenever any bg status existed. Streaming had no off-switch. Separately, project chats still wrote `_out/...` into the global `~/.sinty/workspace/_out` because `tool-fs` always resolved against `ctx.paths.workspace` from plugin init, while the system prompt already claimed the workspace was the project folder.

## Approach

1. **UI status** — drop `.bg-status` chrome; one `.typing` muted line that prefers live bg text, else «Агент думает…», and yields to the streaming bubble while deltas arrive.
2. **Streaming** — client-only checkbox in General prefs; when off, ignore `model.delta` and show text from `model.response` / journal as before. Not under Модели.
3. **Chroot** — agent computes `sessionWorkspace(sessionId)` (`projectDir` + `ensureProjectDirs` when `projectId` is set) and passes it on every `CallCtx` / `ToolRunContext`. `tool-fs` resolves relative paths against that root; `shell.run` and `pathVerdict` use the same root; `tool-web` screenshots write under it. Global workspace unchanged for sessions without a project. Absolute escape from a project root into the parent workspace is refused by `resolveFsPath`.

## Alternatives considered

- Prompt-only reminder to write under the project path — already present and still wrong at runtime.
- Remapping plugin init `paths.workspace` per session — plugins are long-lived and shared across chats.
- Policy-settings plugin / `web.fetch_file` — explicitly out of this pack.

## Files touched

- `packages/sdk/src/tool.ts` — optional `workspace` on `ToolRunContext`
- `packages/core/src/host/protocol.ts` — optional `workspace` on `CallCtx`
- `packages/core/src/agent.ts` — `sessionWorkspace`, wire through call/recover/shell/pathVerdict/systemPrompt folder
- `plugins/tool-fs/src/index.ts` — export `resolveFsPath`; per-call workspace
- `plugins/tool-fs/src/resolve.test.ts` — unit tests
- `plugins/tool-web/src/index.ts` — screenshot dir under session workspace
- `packages/core/src/__tests__/project-workspace.test.ts` — integration: project vs global `_out`
- `apps/web/src/chat.tsx`, `style.css`, `pages.tsx` — status line + streaming pref

## Follow-ups

- `web.fetch_file` + ask/size limits; policy settings plugin UI (admin) on top of current yaml ask/deny.
- Local HTML screenshots should not go through `file://` (netguard); use fs instead.
