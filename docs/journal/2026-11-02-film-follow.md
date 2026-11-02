# The open editor follows the film file

- Date: 2026-11-02
- Area: plugins/diffusion, vendor/diffusion-editor
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

After the reload note, a refresh of the harness still left the timeline on the old cut until the page was loaded again. The note depends on one shared queue and on the folder string matching exactly. The pane the person is looking at was not the one that moved.

The editor page now asks, about once a second, whether `index.tsx` is newer than the last save the canvas itself made. When it is, that page recompiles the film it is already watching. A drag in the canvas writes the file too, and that save is marked so it does not reload the picture out from under the person.

Checked with the film open: rewriting the same bytes made the page request one compile, without a reload.

## Files touched

- `vendor/diffusion-editor/apps/web/public/harness-desktop.js` — polls the open film
- `vendor/diffusion-editor/apps/web/index.html` — `harness-desktop.js?v=6`
- `plugins/diffusion/src/host.ts` — a canvas save is not an outside change

## Design decisions

The poll lives in the page that is open, so it does not matter which copy answers a tool call.

## Rejected alternatives

Another pass at the shared event queue. The queue was already delivering a note, and the visible pane still did not move.

## Migration notes

Ctrl+F5 once, so the open film loads `harness-desktop.js?v=6`. After that, leave the editor open: an agent write shows up on its own.

## Known limitations

The follow watches `index.tsx` only. A new asset with no change to that file still needs the import path's own note.
