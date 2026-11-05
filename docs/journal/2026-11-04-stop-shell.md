# Stop kills shell.run

- Date: 2026-11-04
- Area: packages/core (shell), apps/web (chat), blobs
- Plan step: responsive turns follow-up
- Commits: this commit
- PR: (open)

## What and why

`stop-all` already aborted the turn and waited for it to finish, but `shell.run` ignored that abort. On Windows, `killTree` used `taskkill /T` against the ShellBox cage; ShellBox waits inside a Windows job, and `taskkill` waited with it, so the Stop button sat until the command's own timeout.

`runShell` now takes the turn's `AbortSignal`. Abort (and timeout) call `child.kill("SIGKILL")` on the cage process directly. ShellBox puts the command in a job that dies with the cage, so children go away without `taskkill`. The chat Stop button shows **Останавливаю…** while the request runs and refuses a second click.

The same WIP raises the chat attach / blob stream cap from 512 MB to 8 GB (prompt still only inlines the first 8 MB), tracks in-flight uploads so Send stays disabled until they finish, and allows several uploads at once up to the 8-file composer limit.

## Files touched

- `packages/core/src/shell.ts` — `signal` on `ShellOptions`; abort listener; `killTree` without `taskkill`
- `packages/core/src/agent.ts` — pass turn signal into `runShell`
- `packages/core/src/blobs.ts` / `api/server.ts` — 8 GB cap + shared too-big message
- `packages/core/src/__tests__/shell.test.ts` — abort stops a looping command
- `apps/web/src/chat.tsx` — stopping label; parallel uploads; 8 GB client check; Send waits on uploads

## Design decisions

- Kill the cage process, not the tree via `taskkill`: the job object already reaps children when ShellBox exits.
- Cap raise rides with Stop because both were the same local WIP and both change chat attach UX; prompt inline size stays 8 MB.

## Rejected alternatives

- Keep `taskkill /T` with a short timeout — still races the job wait on Windows.
- Separate PR for the 8 GB blob cap — would leave the Stop WIP half-finished on disk longer.

## Migration notes

None. Existing blobs and sessions are unchanged.

## Known limitations

- Abort resolves `runShell` after at most ~2 s even if the OS is slow to reap; the tool result may look like a non-zero / null exit rather than a dedicated "aborted" flag.
- Non-ShellBox (unsandboxed) Windows shells rely on `child.kill` alone; orphan grandchildren are still possible outside the job.
- Attachments already on disk under the old 512 MB policy are fine; only new uploads use 8 GB.

## How to test

```bash
npm test -w @sinty/core -- src/__tests__/shell.test.ts
```

Manual: start a long `shell.run` in chat, click **Стоп всё** — the button becomes **Останавливаю…** and the command ends in seconds, not at timeout. Attach a multi-GB file — upload proceeds; Send stays off until it finishes.
