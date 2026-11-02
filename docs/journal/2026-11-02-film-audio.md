# The export mixes the timeline audio

- Date: 2026-11-02
- Area: plugins/diffusion
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

The first ffmpeg export drew every layer and left the soundtrack out. The mp4 encoder's audio path paced a worklet with `SharedArrayBuffer`, which the editor frame does not have. The mix itself does not need that buffer.

While the frames are drawn, each clip is scheduled into an `OfflineAudioContext` at its place on the timeline, including trim and volume. After the last frame the context renders one wav. ffmpeg muxes that wav into `_out/video/<film name>/film.mp4`. A film with no audio still gets a picture; the tool says the mix did not render when the context throws.

## Files touched

- `vendor/diffusion-editor/apps/web/src/dapi/handlers/composite.ts` — schedule and render the mix
- `plugins/diffusion/src/host.ts` — mux the wav
- `skills/diffusion-editor/` — the export includes the soundtrack
