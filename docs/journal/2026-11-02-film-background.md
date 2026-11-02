# A film can be cut without the editor pane open

- Date: 2026-11-02
- Area: plugins/diffusion
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

Creating a film, copying an asset and writing the cut all asked the open editor which film it had, then waited 30 seconds. With the pane closed nothing answered, so the agent could not start a film or export it.

Those three now use the chat's project id and the film name. The last film the agent touched stays the current one. A hidden editor in the harness opens that film and mounts the scene, so check, capture and export run there. The visible pane, when it is already on that film, does the work instead, and the person sees it. A green dot blinks beside the project and beside the film while a command is in progress.

The hyperframes renderer still reads `data-width` and `data-height` from the composition. That stays.

## Files touched

- `plugins/diffusion/src/host.ts`, `plugins/diffusion/src/index.ts` — pick a film on disk, wait for the harness editor, report which films are busy
- `vendor/diffusion-editor/apps/web` — the hidden editor follows the film and says when the scene is mounted
- `apps/web/src/app.tsx` — the hidden editor and the dot beside the project
- `skills/diffusion-editor/` — the pane is optional; pass `film` when there are several
