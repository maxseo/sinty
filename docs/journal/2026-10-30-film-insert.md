# A clip dropped on the timeline stays there

- Date: 2026-10-30
- Area: plugins/diffusion
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

Dragging a file from Assets onto the timeline said “Nothing to insert into / Open a project first.” The canvas only inserts into an element that carries a source stamp, and the film compiler never wrote one, so the stage looked like a project that was not open.

The compiler now stamps each composition tag. A drop then built the scene and immediately deleted it, because writing the cut back into the JSX file still answers with an error, and an error tells the editor to throw the new clip away. The write now answers that the clip may stay. The file is not changed.

## Files touched

- `plugins/diffusion/compiler/tags.cjs` — stamp `__source` on each composition tag
- `plugins/diffusion/src/host.ts` — pass the film folder into that stamp, and accept a canvas edit without deleting the clip

## Design decisions

The stamp is `index.tsx:1`, `index.tsx:2`, in the order the tags appear. That is the address the editor already uses.

The edit is kept in the open film only. Writing it into the JSX would need the desktop editor's source writer, which this plugin does not have. Answering with the same pending name is enough for the clip to remain on the timeline.

## Rejected alternatives

Leaving the error string. The message is honest, and it also removes the clip the person just dropped.

## Migration notes

Restart the harness so the plugin process loads the new `dist`. Ctrl+F5, open the film, and drag the file onto the timeline again.

## Known limitations

Closing the film or reloading the tab shows the file again, without the clips added on the canvas. Those clips are not written into `index.tsx` yet.
