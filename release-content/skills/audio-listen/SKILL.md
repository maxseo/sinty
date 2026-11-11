---
name: audio-listen
description: Ask what is heard in an audio or video file with audio.listen. Use for music, speakers, events and approximate times. For a word-for-word transcript use stt.transcribe.
---

# Listening to a file

`fs.read` cannot hear a recording. `vision.look` sees pictures. `stt.transcribe` writes the words down. **`audio.listen`** answers a question about the sound.

## When

- What music is playing, who is speaking, what else is heard
- A rough order of events, not a subtitle and not a cut point

## Do

1. Call **`audio.listen`** with `path` relative to the project.
2. Pass `prompt` with the question. Pass `start` and `end` in seconds when the file is long.
3. Wait for policy **ask** if prompted.
4. Use the returned `text`. Times in the answer count from the start of the window you asked for.

## Do not

- Use this for a transcript, a subtitle, or `sourceIn` / `sourceOut`. That is `stt.transcribe`. Its times are seconds inside the file. Times from this tool count from the start of the window.
- Listen to `_out/video/.../film.mp4` when the question is about the mixed export. For one video or one audio track, pass that source file. A `<video muted>` only silences the timeline. The sound is still in the file.
- Use `diffusion.run` `listen`. That command is gone.
- Assume `models.default` accepts audio. The route is `models.routes.listen`.
