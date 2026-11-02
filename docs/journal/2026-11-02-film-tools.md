# Editor commands take the open scene and the film's files

- Date: 2026-11-02
- Area: plugins/diffusion, vendor/diffusion-editor
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

In the chat «Видео» the agent tried every editor command. `context` and `fonts` answered. The rest failed for three reasons.

The plugin put the first word into `path`. `check`, `capture` and `export` read `id`, so the scene was `"undefined"`. `probe`, `filmstrip`, `waveform`, `listen` and `transcribe` then called `.trim()` on a missing path. `job` called `.startsWith()` on a missing id. `window` and `logs` have no renderer handler (they belonged to the Electron shell). `screenshot` asked that shell for a window picture and got 0×0. `open` with no folder was refused even when a film was already open. `context` did not list scenes or assets, and the film folder is outside the chat workspace, so the agent could not discover an id or a file path.

`context` now includes the scenes and the assets. `check`, `capture` and `export` use the open scene when no id is given. A media command without a path, and `job` without an id, answer what they need instead of throwing. `open` with no folder reports the open film. `window` reports the pane is visible. `logs` is an empty list. `screenshot` renders the open scene and the plugin writes `editor.png` into the chat project.

## Files touched

- `plugins/diffusion/src/index.ts` — argument fields per command, and the screenshot file
- `plugins/diffusion/src/host.ts` — a path outside the film says to use `capture`
- `vendor/diffusion-editor/apps/web/src/dapi/lib/nodes.ts` — an empty id is the open scene
- `vendor/diffusion-editor/apps/web/src/dapi/handlers/context.ts` — scenes and assets
- `vendor/diffusion-editor/apps/web/src/dapi/handlers/screenshot.ts` — the open scene, not a window grab
- `vendor/diffusion-editor/apps/web/src/dapi/lib/assets.ts`, `handlers/open.ts`, `handlers/generate.ts` — missing path, folder, and job id

## Design decisions

`listen`, `transcribe` and `generate` still need an adapter URL. An empty address answers «не подключено». That is the unset connection, not a broken command.

## Rejected alternatives

Teaching the agent the old argument order in the description only. The calls in the log were already the natural ones (`check` with no id, `probe` with no path), and those crashed.

## Migration notes

Ctrl+F5, open the film with «Видео», then `context`. Scene ids look like `index.tsx:2`. Asset paths are the names `context` returns.

## Known limitations

`logs` does not keep a console buffer. `window` cannot hide the pane. A file that is not inside the film still cannot be probed; import it into the film first.
