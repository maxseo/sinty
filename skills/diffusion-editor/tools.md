# Commands

The film must already be open. Every command is `diffusion.run` except the two named tools at the bottom.

`args` is a list of strings. The first value is the positional (a scene id or a library path). Flags are `--prompt` / `-p`, `--start` / `-s`, `--end` / `-e`. Times are seconds (`1.5`), frames (`45f`), or clock (`1:30`). Replies use seconds.

## What works on the open scene

| command | args | reply |
| --- | --- | --- |
| `context` | none | `scenes` (id, name, active) and `assets` (id, name, path, type). Path is the library path, for example `@11.mov`. Both `@11.mov` and `assets/@11.mov` resolve. |
| `check` | scene id, or omit it | node counts, duration, `issues`. A clip is often `shape`: the editor stores a dropped clip as a rect with a paint. That is not a failure. |
| `capture` | scene id, then times in seconds | one PNG `file` per time, under the chat project `_out/diffusion` |
| `screenshot` | none | one PNG `file` of the open scene at the playhead |
| `export` | optional scene id, optional path ending in `.mp4` `.webm` `.mov` `.ogg` | writes the file. No path means `_out/film.mp4` in the chat project. A relative path is inside the chat project. |
| `fonts` | none | family names a `<text fontFamily>` may use |
| `open` | none | the open film's id, name, and folder |

## What needs a library path from context

| command | args | reply |
| --- | --- | --- |
| `probe` | library path | width, height, duration, codecs. Not a picture. |
| `grab` | library path, then a time | one PNG `file` of that media |
| `filmstrip` | library path | one PNG `file`, a row of frames |
| `waveform` | library path | one PNG `file` of the audio |

Look at a `file` with `vision.look`. The path is absolute and inside the chat project, so a relative `_out/diffusion/...` also works.

`transcribe` and `listen` take a library path and a `--prompt` for listen. With no adapter address they return «не подключено».

## Jobs

`diffusion.generate` is a separate tool and asks the person first. Its `args` are the model fields the adapter expects. It returns a job id. `diffusion.run` `job` with that id polls it; `--cancel` stops it. No address means «не подключено». The local model `sam-2.1` segments and tracks inside the editor and does not need an address.

## The source

`diffusion.source`:

- `action: "read"` — the text of `index.tsx`.
- `action: "write"`, `text` — replace the whole file. It must contain `export default`. The open editor reloads.
- `action: "import"`, `path` — copy one file from the chat project into the film library. The reply's `libraryPath` is what `src` should say (a file `assets/logo.png` is `"logo.png"`).

After `write` or `import`, call `context` again before `check`, `capture`, or `export`.
