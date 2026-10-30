# A new film stays on the editor

- Date: 2026-10-30
- Area: plugins/diffusion, vendor/diffusion-editor
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

Creating a film and opening it left the project tab black. The editor asks the plugin to open the film and waits for the answer. That answer was placed on one shared inbox. Any other open copy of the editor takes the whole inbox, so this copy never heard that the film was ready and never painted the canvas. The page background is dark, which is the black pane.

The reply now comes back on the same request, to the copy that asked. The shared inbox is only for messages the plugin pushes on its own.

## Files touched

- `plugins/diffusion/src/host.ts` — return the reply instead of queueing it
- `plugins/diffusion/src/index.ts` — `POST /ipc/out` sends that reply, and the bridge script is not cached
- `vendor/diffusion-editor/apps/web/public/harness-desktop.js` — deliver the reply to the waiting call
- `vendor/diffusion-editor/apps/web/index.html` — load that bridge with a new address so a cached copy is not used

## Design decisions

The request and its reply stay on one HTTP call. Two films can be open and each still receives its own answer.

## Rejected alternatives

Leaving the inbox and hoping only one editor is open. A second tab, including one left open from an earlier check, blanks the film the person is looking at.

## Migration notes

Copy `dist/` and `editor/harness-desktop.js` and `editor/index.html` into the install. Restart the server. Ctrl+F5 the harness.

## Known limitations

Messages the plugin pushes (a tool call into the open film) still use the shared inbox. Two open films can still take each other's tool calls.
