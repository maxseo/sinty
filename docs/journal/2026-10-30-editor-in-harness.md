# The Diffusion tab is the editor

The desktop app was a separate window with their account. The harness needs the editor itself, and the same commands the agent already calls, with our own sign-in and models behind those calls.

## What changed

`vendor/diffusion-editor` is commit `af570c164a5d0ee961040feb1f8d1d40617c291d` of diffusionstudio/editor, without `apps/desktop` and without brand assets. The web app is built to `/p/diffusion/app/` and the Diffusion tab loads it. `harness-desktop.js` replaces the Electron bridge. `diffusion.run` sends the command to the open tab. Cloud calls go to `/p/diffusion/api/call`, which reads `adapters.json` and otherwise answers «не подключено».

## Why

The person asked to take the editor architecture into the harness and hang their own Supabase, generation, transcription and listen on its inputs and outputs. Launching the downloaded program does not do that.
