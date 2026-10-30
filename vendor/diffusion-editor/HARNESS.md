# Harness copy

Pinned commit: `af570c164a5d0ee961040feb1f8d1d40617c291d` of https://github.com/diffusionstudio/editor (MPL-2.0).

The Electron app in `apps/desktop` is not included. Brand assets are not included. The channel types the web app imports live in `apps/web/src/desktop-stub` instead.

Patches in this tree, still under MPL-2.0:

- `apps/web` is built with base `/p/diffusion/app/` and served by the Sinty plugin.
- With no `VITE_SUPABASE_URL`, the login screen is skipped.
- With no `VITE_API_URL`, cloud calls go to `/p/diffusion/api/call`.
- `public/harness-desktop.js` talks to the plugin instead of Electron.

`plugins/diffusion/editor` is the production build of `apps/web` (not committed: it contains a large wasm file). Rebuild with `npm run build --workspace=@diffusionstudio/web` from this folder, then copy `apps/web/dist` to `plugins/diffusion/editor`.
