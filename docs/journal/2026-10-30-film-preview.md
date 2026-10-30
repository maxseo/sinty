# The preview shows a layer, and a drag moves that layer

- Date: 2026-10-30
- Area: vendor/diffusion-editor
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

A clip sat on the timeline and the main window stayed the empty stage colour. Dragging what looked like one layer moved every layer with it.

The editor asks “a shape or a group” in one query. That query is checked once per block of traits. A layer that is only a shape failed the block that holds groups, so the query matched nothing. The preview never drew the scene’s layers, and a drag had only the scene itself to hold, so every layer inside it moved.

The check now accepts a match in any block. The picture and the video draw, and a layer can be selected on its own.

## Files touched

- `vendor/diffusion-editor/patches/koota+0.6.6.patch` — the query accepts an “or” that spans more than one block of traits

## Design decisions

The patch is applied by the editor’s existing `postinstall` (`patch-package`). The editor source is unchanged.

## Rejected alternatives

Replacing every “or” query in the editor. The same check is what the timeline, the selection and the preview all use.

## Migration notes

Ctrl+F5 and open the film again. The built editor in the install already has the fix. A fresh `npm install` inside `vendor/diffusion-editor` reapplies the patch.

## Known limitations

Clips added on the canvas are still kept for the open film only. Reloading the tab shows the file again, without those clips.
