# Film list and editor follow the harness theme

- Date: 2026-11-02
- Area: diffusion editor
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

The editor already had a light palette and a dark palette. The harness always started it on dark, and the film list was one fixed stylesheet. The button «Тема» in the harness now drives both. Dark stays the palette that was on screen. Light uses the editor's existing light tokens and the same light surfaces as the rest of the harness.

## Files touched

- `vendor/diffusion-editor/apps/web/index.html`
- `vendor/diffusion-editor/apps/web/src/app.tsx`
- `plugins/diffusion/src/index.ts`

## Design decisions

`sinty.theme` is the single switch. The editor reads it before paint and again when another frame writes it. The film list does the same on `data-theme`. A separate theme control inside the editor menu would fight the harness button.

## Rejected alternatives

Inventing a second light palette. The editor's `:root` tokens were already the light design.

## Migration notes

Hard-refresh the harness (Ctrl+F5). The film-list page is served with `no-store`, so a refresh is enough for that page after the server restart.

## Known limitations

Clip colors on the timeline stay the same in both themes. Scene headers drawn on the canvas stay dark chips.

## How to test

Press «Тема». The film list and an open editor switch together. Dark matches the previous editor. Light is white panels and a light gray canvas around the picture.
