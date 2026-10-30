# A shell command can ask for one folder outside the project

- Date: 2026-10-30
- Area: packages/core shell
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

In the «Видео» chat the agent approved commands that named FFmpeg and the Playwright Chromium. `assertSandbox` refused a literal path outside the workspace even after the human said yes. `%LOCALAPPDATA%` slipped past that check, then the AppContainer answered «Отказано в доступе» because `ShellBox` only grants the workspace and the Node copy. One command started `chrome.exe` by an absolute path and never exited. `child.kill()` did not kill the grandchildren, so the stall detector blocked the turn after two silent 180s windows.

`shellGrants` now lists the folders a command names outside the workspace. `processCall` asks for those folders before session trust can auto-approve. A yes passes the same list to `runShell`, and `ShellBox --grant` gives them `(OI)(CI)RX` for that process only. The next command asks again. The disk root, the user profile, `$SINTY_HOME` and any `.sinty` segment throw and are never granted. On Linux the same list is `--ro-bind`, and a grant that contains the workspace or the home is skipped. A timeout runs `taskkill /T /F` on Windows, and `ShellBox` puts the command in a job that dies when the box dies.

## Files touched

- `packages/core/src/shell.ts` — `shellGrants`, `assertSandbox`, `killTree`
- `packages/core/sandbox/ShellBox.cs`, `packages/core/sandbox/ShellBox.exe` — `--grant`, kill-on-close job
- `packages/core/src/shell-sandbox.ts` — read-only binds for grants
- `packages/core/src/agent.ts` — the path ask is not skipped by session trust
- `packages/core/src/coretools.ts` — `shell.run` description
- `packages/core/src/__tests__/shell.test.ts`
- `docs/spec/policy.md`

## Design decisions

The grant is per command, not a standing exception. The approval card already shows `reason`, so the folder list is that string (`нужен доступ только к: …`) and the web UI did not change. A file path grants its parent directory, because icacls on a single file would not cover a tool that also reads siblings in the same `bin`.

Network capabilities stay off. The workspace stays read-write as before.

## Rejected alternatives

Letting `--allow-child-process` plugins run the command. That lifts the Node permission model for every child, which is why the cage exists. A persistent allow-list of folders would let a later command reuse a yes the person gave for a different task.

## Migration notes

Restart the server after copying the built `shell.js`, `agent.js`, `shell-sandbox.js` and `ShellBox.exe` into the install. `ShellBox.exe` is rebuilt with `csc /nologo /out:ShellBox.exe ShellBox.cs` from `packages/core/sandbox`.

## Known limitations

The grant is read-only. A command that must write outside the project still cannot. macOS still has no cage. A path that does not exist is still listed; the command then fails with “not found” after the person approves it.

## How to test

`node --test packages/core/dist/__tests__/shell.test.js` after `pnpm --filter @sinty/core run build`. On Windows the grant test reads a marker file only when that directory is passed, and a `node -e` sleep of 60s is reported `timedOut` within the 1.5s limit.
