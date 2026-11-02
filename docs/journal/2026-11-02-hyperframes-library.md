# The Hyperframes tab lists compositions and can install the update

- Date: 2026-11-02
- Area: plugins/hyperframes
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

The tab said a newer npm release existed and only offered «Отметить просмотренным». That stores the new mark and does not install anything. The compositions themselves lived in the workspace folder `hyperframes/<slug>` and were not shown. The tab now has «Установить» / «Обновить», which installs that npm version under the plugin data directory and uses it for the next `hyperframes.render`. The same page lists every saved composition with a preview frame, the name, the stage size, «Открыть» and «Удалить».

## Files touched

- `plugins/hyperframes/src/index.ts`
- `plugins/hyperframes/src/gallery.ts`
- `plugins/hyperframes/src/tab-page.ts`
- `plugins/hyperframes/src/gallery.test.ts`
- `plugins/hyperframes/README.md`

## Design decisions

The preview is one JPEG made with ffmpeg from the mp4, or from a picture in the folder, and kept as `thumb.jpg` until the source is newer. «Открыть» plays the mp4 when there is one, and can also show the HTML composition. Pictures referenced by relative paths are inlined so the preview does not need the folder. Delete removes only that slug directory inside `hyperframes/`.

## Rejected alternatives

Leaving the notice as a mark-as-seen control. The person asked for a way to install the update they were being shown.

## Migration notes

Restart the harness after replacing the plugin, then Ctrl+F5. The tab page is `no-store`.

## Known limitations

A composition with neither a video nor a picture shows «нет кадра». A video larger than 12 MB is not played in the page. The npm install is the package from the registry, so a GitHub commit that is not in that release is only marked seen.

## How to test

Open Hyperframes. With an update, «Установить» is under the notice. Saved compositions are cards. «Открыть» plays the video or shows the HTML. «Удалить» removes that folder.
