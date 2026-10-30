# The editor panels stay visible

- Date: 2026-10-30
- Area: vendor/diffusion-editor
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

Opening a film showed the title bar and a black canvas. Assets, the timeline and the inspector were gone. The editor had remembered “hide the panels”. In the desktop app that is a focus mode. Inside the harness tab it looks like the editor never opened.

In the harness the panels stay on. The button that hides them is not shown there, and a saved “hidden” value is turned back on when the editor loads.

## Files touched

- `vendor/diffusion-editor/apps/web/src/context/layout.tsx` — panels stay visible in the harness
- `vendor/diffusion-editor/apps/web/src/components/sidebar-left/sidebar-left.tsx` — no hide-panels button there
- `vendor/diffusion-editor/apps/web/public/harness-desktop.js` — clear a saved hidden value before the app reads it
- `vendor/diffusion-editor/apps/web/index.html` — load that script from a new address

## Design decisions

The stored flag is left alone for the desktop app. Only the harness ignores it.

## Rejected alternatives

Telling the person to find the small icon in the title bar. The black canvas is what they already reported as a missing editor.

## Migration notes

Copy the built `apps/web/dist` into the install's `plugins/diffusion/editor`. Ctrl+F5 and open the film again. The editor page is read from disk.

## Known limitations

The canvas of a new film is still empty until a clip is added. That is the film, not a missing panel.
