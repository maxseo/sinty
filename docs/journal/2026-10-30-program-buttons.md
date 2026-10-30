# Each program has its own install button

- Date: 2026-10-30
- Area: plugins/runtimes, plugins/hyperframes
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

The Программы tab listed FFmpeg, Python, ImageMagick and Chrome on one line and one button, «Установить недостающее». That button called `POST /install` and the handler did not answer until every download finished. The core closes a plugin HTTP call that has not sent `http.start` within `HTTP_START_TIMEOUT_MS` (120s). The FFmpeg essentials zip is about 110 MB, so the tab reported failure while `ffmpeg.zip` sat half-written under `%LOCALAPPDATA%\Sinty\tools`. A person also could not install one program and leave the others out.

The tab now has one row per program. A missing FFmpeg, Python or ImageMagick row has Установить. Установить все stays and only downloads what is still missing. `POST /install` returns immediately. `startInstall` keeps the work on a queue in the plugin process, and `GET /status` includes `job` (`running`, `step`, `error`) so the page polls every two seconds. Finished bins are prepended to the user PATH. `hyperframes.render` prepends those bins itself, because the plugin process keeps the PATH from server start.

Chrome stays a status row. It is the Playwright Chromium already on disk, not a package this plugin downloads.

## Files touched

- `plugins/runtimes/src/index.ts` — rows, background install, user PATH
- `plugins/runtimes/sinty.plugin.json`, `plugins/runtimes/README.md`
- `plugins/hyperframes/src/index.ts` — `toolBins()` on the render spawn
- `CHANGELOG.md`

## Design decisions

The download stays inside the plugin process instead of raising `HTTP_START_TIMEOUT_MS`. Other plugin routes should still fail fast when a handler hangs. One queue means a second click waits instead of two `curl` processes writing the same zip.

The plugin process runs with `--permission` and may not write `%LOCALAPPDATA%\Sinty\tools`. `mkdir` and `rm` from `node:fs` throw `Use --allow-fs-write`. `permissions.shell` already allows child processes, and those are not confined, so `curl`, `tar`, the Python installer and PowerShell do the disk work. FFmpeg's `bin` is junctioned to `Sinty\tools\ffmpeg` so a later process can put that stable path on `PATH` without listing the versioned folder.

## Rejected alternatives

Waiting inside the HTTP handler with a longer core timeout. That would make every plugin route able to hold a request for ten minutes. Streaming the response open immediately was the other option; polling `job` matches the rest of the tab bridge, which expects one JSON body.

## Migration notes

Restart the server after replacing `plugins/runtimes/dist/index.js` and `plugins/hyperframes/dist/index.js`. The tab page is loaded at request time. Ctrl+F5 the harness so the iframe reloads.

## Known limitations

An install that is running dies if the server process stops. The half-written archive is deleted at the next attempt. Chrome still has no install button. The user PATH update is visible to new terminals, not to programs that were already open.

## How to test

Open Программы. Each missing program has Установить, and Установить все is there. Start ImageMagick (the small archive). The row stays on «нет» while the log says it is downloading, then becomes «есть» without the request dying at two minutes.
