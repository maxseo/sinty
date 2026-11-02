# Menu export writes the scene with ffmpeg

- Date: 2026-11-02
- Area: diffusion editor
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

File → Export scene and File → Export specific scene both called `exportScene`. That path asked the browser for a save location and then encoded with a `SharedArrayBuffer`. The harness iframe has neither, so both menu items stopped before a file existed. They now draw the chosen scene with `renderFrames` and ask the plugin to mux it. The file lands at `_out/video/<film name>/<scene name>.mp4` in the chat project. Export current frame writes a PNG beside it.

The canvas hit list was never cleared. Each frame appended another region for every scene on the stage, so a project with many scenes got slower and clicks walked stale regions. `renderSystem` now empties that list before drawing the frame.

## Files touched

- `vendor/diffusion-editor/apps/web/src/context/export.tsx`
- `vendor/diffusion-editor/apps/web/src/context/render.ts`
- `vendor/diffusion-editor/apps/web/src/dapi/handlers/composite.ts`
- `vendor/diffusion-editor/apps/web/src/desktop-stub/main-channels.ts`
- `vendor/diffusion-editor/packages/runtime/src/systems/render.ts`
- `plugins/diffusion/src/host.ts`

## Design decisions

The menu uses the same frame-and-ffmpeg path as `diffusion.run export`. The scene the menu names is the one that is drawn. Scratch frames are removed after the mp4 exists; a Windows lock on the frame folder is retried and does not fail the export once the file is written.

## Rejected alternatives

Turning COOP/COEP back on so the browser encoder can allocate a `SharedArrayBuffer`. That blanked the sandboxed iframe.

## Migration notes

Hard-refresh the harness (Ctrl+F5) so the editor bundle reloads. The plugin host change needs the restarted server, which is already running.

## Known limitations

New, Open, Duplicate, Move and Show in Explorer still go through the desktop folder commands. In the harness, New creates a film folder and the others do not open an Explorer window. Download all assets still asks the browser for a directory, which this iframe cannot show. Help links leave the app. Select parent and Select children are the stage walk described in `shortcuts.ts`: parent is the node that holds the selection, child is one level of what it holds. A sequence is skipped because the timeline draws it and the canvas does not select it.

## How to test

Open a film, Меню → File → Export → Export specific scene, pick a scene. A progress overlay appears and the mp4 is written under the chat project's `_out/video/<film>/<scene>.mp4`. No save dialog.
