# A film opens, and media is copied into it

- Date: 2026-10-30
- Area: plugins/diffusion, vendor/diffusion-editor
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

Opening a new film showed “Project failed to load” and “Access to this API has been restricted. Use --allow-fs-read”. `compiler.json` pointed `packageJson` at `E:\Vi\sinty\plugins\diffusion\package.json`. The plugin process runs with `--permission` and may not read that path. `existsSync` throws instead of returning false, and the editor shows that throw as the load error. A child process inherits the same grants, so pointing the compiler at the repository does not work either.

Import media did nothing useful. The editor links a picked file by its path. A browser file input does not provide one, so every file was reported as unnamed.

The compiler packages now live in `plugins/diffusion/compiler`, which is inside the plugin directory the process may read. `existsSync` on a forbidden path is treated as unreadable. A missing `assets/` directory lists as empty, which is what the library already expects. A picked or dropped file with no path is written into the film through `PUT /p/diffusion/media` and read back through `GET`. The bytes stay inside that film.

## Files touched

- `plugins/diffusion/src/host.ts` — compiler lookup, missing folders, media read and write
- `plugins/diffusion/src/index.ts` — `GET` and `PUT /media`
- `plugins/diffusion/compiler/package.json`, `compiler.json`
- `vendor/diffusion-editor/apps/web/src/projects/fs.ts` — harness read and write
- `vendor/diffusion-editor/packages/assets/src/browser.ts` — copy files that have no path
- `vendor/diffusion-editor/apps/web/public/harness-desktop.js` — `desktop.harness`

## Design decisions

The copy goes through the plugin HTTP route, not the JSON tool channel. A video does not fit the small JSON messages the editor uses for other calls. The route only accepts a path inside the film directory.

## Rejected alternatives

Adding the repository to the plugin's read grants. That path is this machine's checkout, and the child would still be confined to it. Linking the original file in place needs a path the browser will not give.

## Migration notes

`npm install` in `plugins/diffusion/compiler`, then copy `compiler/` (including `node_modules`), `dist/` and the built editor into the install. Restart the server. The editor page is read from disk; Ctrl+F5 the harness.

## Known limitations

The whole file is held in memory on the way in and on the way back out. A very large video can exhaust that. Playback still asks the browser for the whole file, which is how this editor reads media.

## How to test

Open a film in Видео. The canvas should appear without “Project failed to load”. Import media, pick a video, and it should show under Assets.
