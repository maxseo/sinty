# tool-stt

Workspace audio for the agent: **`stt.transcribe`** reads an mp3/wav/m4a/flac/ogg/webm/mp4 under the session workspace
(project chroot when set) and sends it to `POST /audio/transcriptions` on the speech route. The tool result is text.

`fs.read` is UTF-8, so it cannot hear a file. This plugin is the speech counterpart of `vision.look`.

## Tool

| Name | Policy | What it does |
|------|--------|----------------|
| `stt.transcribe` | ask (`external`) | `path` or `paths` + optional `language` (`ru`) + optional `prompt` |

## Model route

1. `plugins.config.tool-stt.modelRoute` if set (Settings → STT), else
2. `models.routes.stt`

There is no fallback to `models.default`. A chat model does not implement `/audio/transcriptions`.
Set the route to an openai-compat speech model, for example `openai/whisper-1`.

## Settings / config keys

| Key | Default | Notes |
|-----|---------|--------|
| `modelRoute` | `""` | Named route or `provider/model` |
| `maxAudioMb` | `25` | Hard cap of the transcription endpoint |
| `language` | `""` | ISO-639-1. Empty lets the model detect it |

## Skill

```bash
sinty skills add ./skills/stt-transcribe
```

## Permissions

- `fs.read`: `$WORKSPACE`, `$SKILLS`
- `models`: `stt`, `*` (an override may be any route / provider/model)
