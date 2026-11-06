# Session-root writes for HyperFrames and rhany

- Date: 2026-11-06
- Area: `plugins/hyperframes`, `packages/core` (`$SESSION` / session-fs IPC), `packages/sdk`, `docs/examples/rhany`
- Plan step: Max asked for plugin files to land in the current session root (`tool.workspace`), not a hardcoded global workspace; rhany must read project `_inbox` without `$WORKSPACE`
- Commits: this commit
- PR: (open, stacked on `cursor/usage-dashboard-a591` / #88)

## What and why

In a project chat the session root is `workspace/projects/<slug>`. With no project it is the global workspace. HyperFrames already copied finished video to `tool.workspace/_out/video/<slug>/film.mp4`, but `hyperframes.write` and the HTML composition folder still used `ctx.paths.workspace/hyperframes`, which is always the global desk. That forced `../hyperframes` escapes from a project chroot.

`rhany` is an agent-made plugin. Those plugins may not ask for `$WORKSPACE`, so project `_inbox` paths failed and the agent looped. Max does not want agent-made plugins to receive the entire global desk.

## Files touched

- `plugins/hyperframes/src/gallery.ts`, `index.ts`, tests, README — write/render use `tool.workspace` when present; render still opens a leftover global composition; the tab lists global and project folders.
- `packages/sdk/src/tool.ts` — `readSessionFile` / `writeSessionFile` on `ToolRunContext`.
- `packages/core/src/host/session-fs.ts`, `manifest.ts`, `host.ts`, `runner.ts`, `protocol.ts`, `agent-plugins.ts` — `$SESSION` grant, per-call IPC, no Node `--allow-fs-read` of `paths.workspace`.
- `packages/core/src/__tests__/session-fs.test.ts` — path rules; project vs no-project; escape to another project refused.
- `docs/examples/rhany` — drop-in 0.1.9 with `$SESSION` and install notes for the home copy on KOMPUTER.
- `docs/spec/plugin-rules.md`, `docs/spec/plugin-manifest.md`, `CHANGELOG.md`, this entry.

## Design decisions

- **Session root = `tool.workspace`.** A project chat writes under that project. No project means the session root is the global workspace, so `workspace/hyperframes` is correct there.
- **HyperFrames does not need core changes.** It already has `$WORKSPACE`, which includes `workspace/projects/<slug>`. The bug was using `ctx.paths.workspace` (init-time global) instead of the per-call session root.
- **`$SESSION` is not an alias for `$WORKSPACE`.** Expanding it at process start would grant every project and the loose global files to a long-lived plugin process. Node cannot add `--allow-fs-read` per call, so the host reads and writes the file and sends bytes over IPC. The path is checked against that call's `CallCtx.workspace`.
- **rhany stays a home plugin.** Bundling it next to `runninghub` would change its identity. The PR ships a reviewable tree plus `INSTALL.md` so the copy in `%USERPROFILE%\.sinty\plugins\rhany` can be replaced. Home plugins shadow bundled ones anyway.
- **Prefer HTTPS image URLs when they exist.** Local `_inbox/...` must still work without copying into `$DATA` by hand; the plugin may copy into `$DATA/in` after the host has read the session file, so the existing upload path can `readFileSync` a granted file.

## Rejected alternatives

- Granting `$WORKSPACE` to agent-made plugins, or expanding `$SESSION` to `paths.workspace` in `permissionArgs`. That is the whole desk, including other projects.
- A symlink of the current session under `$DATA`. Node follows realpaths, so the target would still need a workspace grant.
- Dual-writing HyperFrames HTML to both global and session folders. New writes follow the session root; old global compositions remain readable.

## Migration notes

- New HyperFrames compositions in a project chat appear under that project. Compositions written before this change stay in the global `hyperframes/` folder and still render.
- rhany on KOMPUTER must be copied from `docs/examples/rhany` over the home plugin and Sinty reloaded. The live `config.yaml` is not edited.

## Known limitations

- The Hyperframes sidebar tab has no current-session id, so it lists the global folder and every `projects/<slug>/hyperframes`. A duplicate slug prefers the global copy when opening or deleting.
- `readSessionFile` is capped at 50 MB.
- `$SESSION` writes are implemented in the host; this rhany build only needs session reads. Outputs still go to `$DATA`.

## How to test

- `pnpm --filter @sinty/plugin-hyperframes test`
- `packages/core` `session-fs.test.ts` (and the existing `$WORKSPACE` refusal in `agent-made-plugins.test.ts`)
- `node --test docs/examples/rhany/src/paths.test.ts`
- Manual: in a project chat, `hyperframes.write` should create `workspace/projects/<slug>/hyperframes/<name>/index.html`. After installing rhany 0.1.9, `rhany.run` with `files[].path = "_inbox/photo.png"` should upload that project file.
