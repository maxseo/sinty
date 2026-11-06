# rhany 0.1.9 — install on KOMPUTER

This folder is a drop-in replacement for the agent-made plugin at `%USERPROFILE%\.sinty\plugins\rhany` (or `~/.sinty/plugins/rhany`). It is not a bundled Sinty plugin: the official RunningHub catalog stays `plugins/runninghub`. Home plugins are loaded first, so the copy on disk is the one that runs.

## Why

Agent-made plugins cannot ask for `$WORKSPACE` (the whole global desk). They can ask for `$SESSION`, which the host resolves to the current call's session root (`tool.workspace`): `workspace/projects/<slug>` in a project chat, or the global workspace when there is no project. `files[].path` such as `_inbox/photo.png` is read through that IPC; `$DATA` and `$PLUGIN` still work.

## Steps

1. Stop Sinty or disable `rhany`.
2. Copy this folder over `%USERPROFILE%\.sinty\plugins\rhany\` so these files replace the old ones:
   - `sinty.plugin.json` (must list `"$SESSION"` in `permissions.fs.read`)
   - `src/index.ts`
   - `src/paths.ts` (optional helper)
   - `src/index.test.ts` and `src/paths.test.ts` if you keep tests
3. Restart Sinty, or turn the plugin off and on, so the host reloads the manifest. `$SESSION` is not a Node `--allow-fs-read` of the global workspace; a reload is required for the new grant.
4. In a project chat, `rhany.run` with `files: [{ field: "imageUrls", path: "_inbox/photo.png" }]` should find the project file. Prefer HTTPS `payload.imageUrls` when a public link already exists.

Do not add `$WORKSPACE` to this plugin. The agent still cannot widen an agent-made plugin that far.
