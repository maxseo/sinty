# The film source is the edit, and pictures come back as files

- Date: 2026-11-02
- Area: plugins/diffusion, skills/diffusion-editor
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

After the argument fix, the chat «Видео» could read the open scene, probe `@11.mov`, and write a screenshot into the project. The rest of the loop still failed.

`filmstrip`, `waveform`, `grab` and `capture` returned the PNG as a JSON map of bytes. A filmstrip is several megabytes, so it filled the chat, and the file the plugin later wrote sat in the workspace root, which the project chat cannot read. `export` refused a relative path, and an absolute path never opened a file because the editor's write channels had no handler (`Cannot destructure property 'id'`). `fs` cannot see the film folder, and the official editor has no command that pushes a clip: the agent is supposed to edit `index.tsx`.

Picture results are now files under the chat project's `_out/diffusion`. `export` writes `_out/film.mp4` there unless a path inside the project is given, through `file:write-open` / `chunk` / `close`. `diffusion.source` reads or replaces `index.tsx` and tells the open editor to reload, or copies one chat-project file into the film library. The skill `diffusion-editor` is that loop: `context`, edit the source, `check`, then a picture, and `export` only when asked.

A forked plugin folder can contain `compiler/package.json` without `node_modules`. That package was chosen first, so a restart compiled nothing and the canvas stayed empty. The compiler is used only when `esbuild` actually loads.

## Files touched

- `plugins/diffusion/src/index.ts` — picture files, export path, `diffusion.source`
- `plugins/diffusion/src/host.ts` — file writer, compiler lookup, writer lookup, `projects:changed`
- `plugins/diffusion/sinty.plugin.json`, `plugins/diffusion/README.md`
- `skills/diffusion-editor/SKILL.md`, `tools.md`, `jsx.md`

## Design decisions

The skill is three files. `SKILL.md` is the loop. `skill.read_file` loads `tools.md` and `jsx.md`. It is bound to the agent Синтия, whose skill list is explicit.

`generate`, `listen` and `transcribe` still answer «не подключено» until `adapters.json` has an address. `sam-2.1` is the local model that does not need one. There is no `report` command and no download command.

## Rejected alternatives

Leaving the agent to patch the plugin, which is what the chat did. The patch wrote pictures into the workspace root and did not give the agent the film source.

## Migration notes

Ctrl+F5. The film has to be open with «Видео». A new session of the agent picks up `diffusion-editor` after `sinty web` restarts.

## Known limitations

A fork of the plugin still needs the compiler packages installed beside it. `window` stays visible. `logs` stays empty.
