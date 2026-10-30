# A new film renders

- Date: 2026-10-30
- Area: plugins/diffusion
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

The editor opened, then showed “Project failed to render” and “DOM content must be inside <html> or <htmlPaint>”. The starter is `<stage>`. The compiler left that tag lowercase, and a lowercase tag is HTML. The stage only accepts composition elements, so the empty film never mounted.

Composition tags are now rewritten to the PascalCase components the editor mounts (`<stage>` becomes `Stage`). Inside `<svg>`, the names both sides share (`rect`, `text`, and the rest) stay SVG.

## Files touched

- `plugins/diffusion/compiler/tags.cjs` — the rewrite
- `plugins/diffusion/src/host.ts` — run it before the Solid preset

## Design decisions

The rewrite happens on the JSX, before Solid compiles it, so `<Stage>` becomes a component import from `@diffusionstudio/jsx`. That module is already what a compiled film is allowed to load, and it exports those components.

## Rejected alternatives

Uppercasing every `createElement` string after the compile. By then an SVG `<rect>` and a composition `<rect>` look the same, and the SVG one would become a shape on the stage.

## Migration notes

Copy `dist/host.js` and `compiler/tags.cjs` into the install. Restart the server. Ctrl+F5 and open the film again.

## Known limitations

The compile still does not stamp `__source` on elements, so a canvas edit is not written back into the JSX.
