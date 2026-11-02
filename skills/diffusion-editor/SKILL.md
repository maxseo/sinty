---
name: diffusion-editor
description: Cut a film in the Synt Studio editor beside the chat. Use for timeline, scenes, clips, titles, export, filmstrip, or diffusion.run. Read this, then tools.md and jsx.md, before the first edit.
---

# Synt Studio

The film open in the chat's **Видео** pane is the document. The source file is the edit. There is no command that pushes a clip onto the timeline.

## Before anything

1. The person must have the film open (button **Видео** in the chat header, left of the agent). If a command says the editor is not answering, ask them to open it. Do not open a second editor tab.
2. `skill.read_file` `tools.md`, then `jsx.md`. Do not invent flags.
3. `diffusion.run` `context`. That lists the scene id (`index.tsx:2`) and each asset's library path (`@11.mov`).
4. `diffusion.source` `read` before you change the cut.

## The loop

1. Change the cut with `diffusion.source` `write`: the whole `index.tsx`, lowercase tags, one `export default`. The open editor reloads.
2. `diffusion.run` `context` again. Ids follow the order of tags and change when the file changes. Use the new id.
3. `diffusion.run` `check` with no id. An empty `issues` list means the scene mounted.
4. Look at a frame: `diffusion.run` `screenshot`, or `capture` with the scene id. The reply has a `file` under the chat project `_out/diffusion`. `vision.look` that path. Do not `fs.read` a PNG.
5. Export only when the person asked for a file. `diffusion.run` `export` writes `_out/film.mp4` in the chat project.

## Do not

- Do not `fs.list` or `fs.read` the film folder. It sits outside the chat project. `diffusion.source` is the door.
- Do not patch this plugin when a command fails. Report the sentence the tool returned.
- Do not call `filmstrip`, `waveform`, `grab`, or `capture` a second time if the reply already has a `file`. The bytes are not supposed to appear in the chat.
- Do not use `window` or `logs` to debug a cut. The pane is the window. The log list is empty.
- `generate`, `listen`, and `transcribe` answer «не подключено» until an address is set. Say so. Do not invent a model name except the local segmenter `sam-2.1`, which needs no address.
- There is no `report` command and no download command.
