---
name: stt-transcribe
description: Transcribe audio and video files in the project with stt.transcribe. Use for the words, phrase times, and cuts. For what the sound is, use audio.listen.
---

# Transcribing audio in the workspace

Files that only live on disk (`_inbox/voice.mp3`, a reel in `_out/video`) do not reach the model as sound.
`fs.read` returns UTF-8 garbage for binaries. Use **`stt.transcribe`**.

## When

- The human points at a path ending in `.mp3` / `.wav` / `.m4a` / `.flac` / `.ogg` / `.webm` / `.mp4`
- You need the spoken words, a subtitle, or the file time of a phrase to cut on
- You do not need this to name the music, the speaker, or other sounds. That is `audio.listen`

## Do

1. Call **`stt.transcribe`** with:
   - `path` — one file, relative to the project/workspace (or `skills:…`)
   - `paths` — several files. Each clip is its own request
   - `language` — `ru` or another ISO-639-1 code when you know it
   - `prompt` — names and spellings the model should prefer
2. Wait for policy **ask** if prompted (local read + paid speech call).
3. Use the returned `text` for the words. Use `clips[].segments` to cut on a phrase: each segment has `start` and `end` in seconds, `words` with their own times when the model sends them, and `speaker` when the model tells voices apart. The same JSON is written to `_out/stt/<name>.json`.
4. `whisper-1` fills word times and leaves `speaker` empty. A model whose id contains `diarize` fills `speaker`. Do not invent a speaker label the file does not have.
5. On a film, those times are seconds inside the source file. Put them on `sourceIn` and `sourceOut` of the `<video>` or `<audio>` that plays that file. The tag's `start` is the place on the scene. One call per source. A muted video still has speech in the file. The tool reads the whole file and has no window. Transcribe `_out/video/.../film.mp4` only when the question is about the mixed export.

## Do not

- `fs.read` an audio or video file to hear it.
- Send the clip to `vision.look`. That tool reads pictures.
- Assume `models.default` can transcribe. The route is `models.routes.stt` or Settings → STT, an openai-compat speech model such as `openai/whisper-1`.

## Install

```bash
sinty skills add ./skills/stt-transcribe
```

Or Settings → Skills → Добавить. Plugin `tool-stt` is on by default.
