---
name: diffusion-editor
description: Cut a film in the Synt Studio editor beside the chat. Use for timeline, scenes, clips, titles, export, filmstrip, or diffusion.run. Read this, then tools.md and jsx.md, before the first edit.
---

# Synt Studio

A film in this chat's project is the document. The source file is the edit. There is no command that pushes a clip onto the timeline. The **Видео** pane does not have to be open: create, import, the cut and the export run while the person is in the chat. If they open the film, they see the cut update.

## Before anything

1. `skill.read_file` `tools.md`, then `jsx.md`. Do not invent flags.
2. Name the film. `diffusion.film` with `name` creates one and makes it the current film. When the project already has several, pass `film` (the name or the id) to `diffusion.source` and `diffusion.run`. One film in the project is used when `film` is omitted.
3. `diffusion.run` `context`. That lists the scene id (`index.tsx:2`) and each asset's library path (`@11.mov`).
4. `diffusion.source` `read` before you change the cut.

## The loop

1. Change the cut with `diffusion.source` `write`: the whole `index.tsx`, lowercase tags, one `export default`. Every open editor reloads the file on its own. Do not ask the person to refresh the page. A `check` in the same second can still describe the previous cut; look again before saying the file did not apply.
2. `diffusion.run` `context` again. Ids follow the order of tags and change when the file changes. Use the new id.
3. `diffusion.run` `check` with no id. An empty `issues` list means the scene mounted.
4. Look at a frame: `diffusion.run` `screenshot`, or `capture` with the scene id. The reply has a `file` under the chat project `_out/diffusion`. `vision.look` that path. Do not `fs.read` a PNG.
5. Export only when the person asked for a file. `diffusion.run` `export` draws every layer on the timeline, mixes the timeline audio, and ffmpeg writes `_out/video/<film name>/film.mp4`.

## Files

A new film is `diffusion.film` with a `name`. It shows up in the Видео list and is the film the next `diffusion.source` and `diffusion.run` use. Pass `film` to work on a different one. The person does not have to open it first.

Anything in the film library is copied to `_inbox/assets/<film name>/` in the chat project. Read and copy those files. Do not read the film folder under the harness data directory.

## Do not

- Do not `fs.list` or `fs.read` the film folder. It sits outside the chat project. `diffusion.source` is the door.
- Do not patch this plugin when a command fails. Report the sentence the tool returned.
- Do not call `filmstrip`, `waveform`, `grab`, or `capture` a second time if the reply already has a `file`. The bytes are not supposed to appear in the chat.
- Do not use `window` or `logs` to debug a cut. The pane is the window. The log list is empty.
- `generate`, `listen`, and `transcribe` answer «не подключено» until an address is set. Say so. Do not invent a model name except the local segmenter `sam-2.1`, which needs no address.
- There is no `report` command and no download command.
