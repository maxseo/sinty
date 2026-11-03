# The film list survives a Windows copy failure

- Date: 2026-11-03
- Area: plugins/diffusion
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

Opening Видео listed no films and showed `The operation completed successfully` plus the path `_inbox/assets/syntet-harness-promo/film.mp4`. The same throw stopped `diffusion.source`, `diffusion.run` and `diffusion.film` in the Рилс chat after a few milliseconds, and the supervisor then stopped the turn.

`filmInfos` calls `mirrorAssets` for every film. That function copies a newer library file over the inbox copy with `fs.cpSync`. On this Windows Node, `cpSync` tries to unlink the destination and throws `ERR_FS_CP_EINVAL` with syscall `unlink` and the message `The operation completed successfully`. `copyFileSync` of the same pair succeeds. Because the throw left `filmInfos`, the films page printed the message and drew no rows.

## Files touched

- `plugins/diffusion/src/host.ts`

## Design decisions

`mirrorAssets` now uses `copyFileSync` for one file. A copy that still fails is skipped, so one locked inbox file does not hide the other films or fail a command on a different film.

## Rejected alternatives

Leaving `cpSync` and only catching the error would hide the throw, and the inbox copy would stay stale even when a plain copy works.

## Migration notes

None. Existing films and inbox files stay where they are.

## Known limitations

A file that cannot be replaced stays at the old inbox copy. The film library itself is unchanged.

## How to test

Call `listFilms` for a project whose inbox already has a newer-library `film.mp4`. It returns the film names. On Windows, `fs.cpSync` of that pair still throws; `copyFileSync` does not.
