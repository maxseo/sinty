# The Diffusion tab was a blank page

Opening `/p/diffusion/app` in its own window showed the editor. The same address inside the harness tab stayed white.

## What changed

The editor HTML no longer sends `Cross-Origin-Opener-Policy: same-origin` or `Cross-Origin-Embedder-Policy`. Those headers made the sandboxed frame stay blank. `harness-desktop.js` is loaded from `/p/diffusion/app/harness-desktop.js`, and the editor always uses hash routes, so `/p/diffusion/app` opens the project list instead of the 404 page. The Diffusion iframe is `allow-scripts allow-same-origin` so its scripts and storage run in the frame. The main pane that holds a plugin tab fills the height.

## Why

The person opened Diffusion and saw an empty pane. The editor was built and served; the frame never painted it.
