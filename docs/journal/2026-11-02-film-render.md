# A film's assets, a new film, and a full-picture render

- Date: 2026-11-02
- Area: plugins/diffusion, apps/web, packages/core
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

The agent could not read a clip that lived only in the film library, could not create a film, and the export died on `SharedArrayBuffer` before any picture was written. A long render was also treated as silence: the host stopped `diffusion.run` at 120 seconds, and the stall watch stopped a render that was still drawing. The sidebar called every background wait «фон», so a supervisor stop looked like a question that never arrived in the chat.

Library files are copied into the chat project at `_inbox/assets/<film name>/`. `diffusion.film` creates a film and that folder. `diffusion.run` `export` draws every timeline layer to JPEG frames (the same step as the editor's picture capture, without the mp4 encoder) and ffmpeg writes `_out/video/<film name>/film.mp4`. The soundtrack is not in that file: mixing it is the part that needed `SharedArrayBuffer`. `hyperframes.render` writes its mp4 into `_out/video/<slug>/` as well.

`diffusion.run` and `hyperframes.render` may run for 10 minutes. While a tool call is in flight the stall watch is pulsed, so a live command is not silence. The tool's own timeout remains the hang limit. A background wait is labeled with its reason (одобрение, вопрос, бюджет, супервизор) in the sidebar and as a line in the chat. A message sent while a turn is still running is shown as waiting.

## Files touched

- `plugins/diffusion/src/host.ts` — copy library files into the chat project, assemble frames with ffmpeg
- `plugins/diffusion/src/index.ts` — `diffusion.film`, export path, tool timeout
- `vendor/diffusion-editor/apps/web/src/dapi/handlers/composite.ts` — draw every layer of the workarea
- `vendor/diffusion-editor/apps/web/src/dapi/handlers/export.ts` — harness export uses that draw
- `plugins/hyperframes/src/index.ts` — mp4 lands in `_out/video/<slug>/`, ten minute limit
- `packages/core/src/agent.ts` — pulse the stall watch during a tool call
- `apps/web/src/app.tsx`, `apps/web/src/chat.tsx` — say what the background is waiting for
- `skills/diffusion-editor/` — the new loop
