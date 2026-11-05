# Timed transcripts, audio questions, editor commands

- Date: 2026-11-04
- Area: tool-stt, tool-listen, diffusion, models
- Plan step: none
- Commits: this commit
- PR: #86

## What and why

`stt.transcribe` asked the speech server for plain text. A cut needs the time of each word, and a speaker label when the model has one. The tool now asks for `verbose_json` (or `diarized_json` when the model id contains `diarize`) and, if that format is refused, falls back to plain `json`. The reply and `_out/stt/<name>.json` carry `segments` with `start`, `end`, `words` and `speaker`.

Questions about a recording (music, who is speaking, what else is heard) are not transcription. `audio.listen` extracts a 16 kHz mono mp3 with ffmpeg and sends it as `input_audio` on `models.routes.listen`. Settings → Models has the row **listen — разбор звука**.

`diffusion.run` no longer offers `generate`, `transcribe`, `listen`, `job`, `logs` or `window`, and `diffusion.generate` is gone. Pictures and video stay on RunningHub. Speech stays on `stt.transcribe`. Sound questions stay on `audio.listen`.

## Files touched

- `plugins/provider-openai-compat/src/index.ts` — verbose transcription and `input_audio`
- `plugins/tool-stt`, `plugins/tool-listen`
- `plugins/diffusion/src/index.ts`, `skills/diffusion-editor`
- `packages/core/src/config.ts` — route `listen`, plugin `tool-listen` on by default
- `apps/web/src/pages.tsx`

## Design decisions

Speaker labels are passed through. They are not invented. `whisper-1` returns word times and no speakers. A diarize model fills `speaker`.

`audio.listen` does not fall back to `models.default`. A text-only model would refuse the clip or ignore it.

## Rejected alternatives

Wiring `listen` back through the editor adapter. The editor only forwarded the clip to `qwen3.8-omni-flash` on a URL we do not have.

Keeping `diffusion.generate` for SAM 2.1. The tool still cannot pass the point and the box. The mask stays a later command.

## Known limitations

Word times depend on the speech server accepting `verbose_json`. A server that only returns text still returns `text`, with no `segments`. A listen model that does not accept audio still refuses the clip.

The first `audio.listen` calls failed before the model: the plugin created its mp3 in the system temp directory, and the process has no write grant there. The clip is now written under the plugin data folder (`$DATA`), which the manifest is allowed to write, and deleted after the call.

The skills now say how the two tools meet a cut. `stt.transcribe` times are seconds inside the source file and become `sourceIn` / `sourceOut`. `audio.listen` times count from the window and are not cut points. One call per source file. The mixed export is only for a question about the mix. A `muted` video still has its sound in the file.

A chat upload stopped at 512 MB in both the composer and `BLOB_MAX_BYTES`. `test.mp4` was larger than that, so it never left the browser. The cap is 8 GB. The stream still writes the file in chunks, and the prompt still inlines only the first 8 MB. The send button and Enter stay inactive until every selected file has finished uploading.

## How to test

`pnpm --filter @sinty/plugin-provider-openai-compat test`, `pnpm --filter @sinty/plugin-tool-stt test`, `pnpm --filter @sinty/plugin-tool-listen test`, and the core `models` and `tool-web` tests. Settings → Models shows **listen — разбор звука**. Settings → Аудио shows the length field.
