# Commands

The Видео pane does not have to be open. Every command is `diffusion.run` except `diffusion.source` and `diffusion.film`. Pass `film` (name or id) when the project has more than one film. After `diffusion.film`, that new film is the default.

`args` is a list of strings. The first value is the positional (a scene id or a library path). Flags are `--prompt` / `-p`, `--start` / `-s`, `--end` / `-e`. Times are seconds (`1.5`), frames (`45f`), or clock (`1:30`). Replies use seconds.

## What works on the open scene

| command | args | reply |
| --- | --- | --- |
| `context` | none | `scenes` (id, name, active) and `assets` (id, name, path, type). Path is the library path, for example `@11.mov`. Both `@11.mov` and `assets/@11.mov` resolve. |
| `check` | scene id, or omit it | node counts, duration, `issues`. A clip is often `shape`: the editor stores a dropped clip as a rect with a paint. That is not a failure. |
| `capture` | scene id, then times in seconds | one PNG `file` per time, under the chat project `_out/diffusion` |
| `screenshot` | none | one PNG `file` of the open scene at the playhead |
| `export` | optional scene id, optional file name | draws every timeline layer, mixes the timeline audio, then ffmpeg writes `_out/video/<film name>/film.mp4`. A relative name lands in that folder. |
| `fonts` | none | family names a `<text fontFamily>` may use |
| `open` | optional `film` | that film's id and name |

## What needs a library path from context

| command | args | reply |
| --- | --- | --- |
| `probe` | library path | width, height, duration, codecs. Not a picture. |
| `grab` | library path, then a time | one PNG `file` of that media |
| `filmstrip` | library path | one PNG `file`, a row of frames |
| `waveform` | library path | one PNG `file` of the audio |

Look at a `file` with `vision.look`. The path is absolute and inside the chat project, so a relative `_out/diffusion/...` also works.

Spoken words and cut points are `stt.transcribe`. File times become `sourceIn` and `sourceOut`. A question about the sound is `audio.listen`, and its times are not cut points. See **Sound on the cut** in SKILL.md. A generated picture or video is `runninghub`. Those are not commands of this editor.

## A new film

`diffusion.film` with `name` creates a film in this chat's project and an empty `_inbox/assets/<name>/`. It becomes the film the next command edits. The person can open it from the Видео list and watch; they do not have to.

## The source

`diffusion.source`:

- `action: "read"` — the text of `index.tsx`. Optional `film`.
- `action: "write"`, `text` — replace the whole file. It must contain `export default`. An open editor reloads. Optional `film`.
- `action: "import"`, `path` — copy one file from the chat project into the film library and into `_inbox/assets/<film name>/`. The reply's `libraryPath` is what `src` should say (a file `assets/logo.png` is `"logo.png"`). Read the inbox copy, not the film folder.

After `write` or `import`, call `context` again before `check`, `capture`, or `export`.
