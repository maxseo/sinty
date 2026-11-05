---
name: stt-transcribe
description: Transcribe audio and video files in the project with stt.transcribe. Use instead of fs.read on mp3, wav, m4a, flac, ogg, webm and mp4.
---

# Transcribing audio in the workspace

Files that only live on disk (`_inbox/voice.mp3`, a reel in `_out/video`) do not reach the model as sound.
`fs.read` returns UTF-8 garbage for binaries. Use **`stt.transcribe`**.

## When

- The human points at a path ending in `.mp3` / `.wav` / `.m4a` / `.flac` / `.ogg` / `.webm` / `.mp4`
- You need the spoken words, not a description of the file

## Do

1. Call **`stt.transcribe`** with:
   - `path` — one file, relative to the project/workspace (or `skills:…`)
   - `paths` — several files. Each clip is its own request
   - `language` — `ru` or another ISO-639-1 code when you know it
   - `prompt` — names and spellings the model should prefer
2. Wait for policy **ask** if prompted (local read + paid speech call).
3. Use the returned `text`. For several files, each section starts with the path.

## Do not

- `fs.read` an audio or video file to hear it.
- Send the clip to `vision.look`. That tool reads pictures.
- Assume `models.default` can transcribe. The route is `models.routes.stt` or Settings → STT, an openai-compat speech model such as `openai/whisper-1`.

## Install

```bash
sinty skills add ./skills/stt-transcribe
```

Or Settings → Skills → Добавить. Plugin `tool-stt` is on by default.
