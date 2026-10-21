# Linux sandbox for shell.run (bubblewrap)

- Date: 2026-10-22
- Area: `packages/core` (`shell.ts`, new `shell-sandbox.ts`, `agent.ts`, `config.ts`), `packages/cli` (`doctor`)
- Plan step: overnight item 6; plan section "Shell — пока оставить в ядре, сначала закрыть песочницу на Linux"
- Commits: this commit

## What and why

On Windows `shell.run` runs inside `ShellBox.exe`, an AppContainer without capabilities: no network and only the
granted workspace. On Linux the same tool ran `spawn(line, { shell: true })` as the user, with the full environment
(every `SINTY_SECRET_*` and provider key) and read access to the whole account, `~/.sinty/secrets.json` and the
secret key included. Approval was the only barrier. Moving the tool into a plugin would not help: the plugin would
need `--allow-child-process`, which lifts the Node permission model for its children.

Now on Linux `runShell` asks `decideSandbox()` and, when bubblewrap works, runs `bwrap <bwrapArgs> -- /bin/sh -c
<command>`. The sandbox:

- binds `/usr /bin /sbin /lib /lib32 /lib64 /libx32 /etc /opt` read-only (merged-/usr symlinks are recreated with
  `--symlink`), mounts an empty `/tmp`, a private `/dev` and `/proc`;
- binds the folder of `process.execPath` and every absolute `PATH` folder read-only, except a folder that is the
  workspace's, `$SINTY_HOME`'s or `$HOME`'s ancestor (it would expose all of them), one inside the workspace (already
  visible) and one inside `$SINTY_HOME` other than the Node folder;
- binds the workspace (real path) read-write and `chdir`s into the requested `cwd`;
- `--unshare-all --new-session --die-with-parent`: no network unless `shell.network: true` (`--share-net`, plus the
  `/run` folders `resolv.conf` may point to), no TTY injection, the command dies with bwrap on timeout;
- `--clearenv` and sets `PATH`, locale variables, `TERM`, `TZ`, `shell.passEnv`, `HOME=<workspace>`,
  `TMPDIR=/tmp`; names starting with `SINTY_SECRET_` are dropped even when listed.

## Files touched

- `packages/core/src/shell-sandbox.ts` (new): `findBwrap`, `probeBwrap` (cached), `decideSandbox`, `bwrapArgs`,
  `resetSandboxProbe`.
- `packages/core/src/shell.ts`: `ShellOptions`, `ShellSandboxError`, the bwrap branch, one warning per process.
- `packages/core/src/agent.ts`: passes `config.shell`, `strict`, `paths.home`, `log`; `sandbox_unavailable` error.
- `packages/core/src/config.ts`: optional `shell: { sandbox, network, passEnv }`.
- `packages/core/src/index.ts`: exports; `packages/cli/src/bin.ts`: `sinty doctor` line.
- `packages/core/src/__tests__/shell-sandbox.test.ts` (new, 6 tests); `docs/spec/policy.md` "Shell sandbox";
  `CHANGELOG.md`.

## Design decisions

- Core, not a plugin: `shell.run` is a core tool (see "Why" above), so the sandbox is where the spawn is. The tool's
  name, description and schema are unchanged, so the cache-friendly static prompt is byte-identical.
- bubblewrap over nsjail or a container: it is packaged in Debian, Ubuntu, Fedora and Arch (Flatpak depends on it),
  needs no daemon or root, and starts in milliseconds.
- Default `auto` with a fallback instead of a hard requirement: many Linux machines (WSL, CI containers, hardened
  Ubuntu) cannot create user namespaces; refusing there would break `shell.run` for existing installs in standard
  mode. Strict mode, which promises confinement, refuses instead.
- No network by default, to match the Windows cage. `npm install`, `git clone`, `curl` need `shell.network: true`.
- Cleared environment: the Windows cage inherits the environment, but there the AppContainer cannot read the user's
  files; on Linux the environment is the largest leak (provider keys, `SINTY_SECRET_*`).
- The probe runs `bwrap --unshare-all … /bin/sh -c "exit 0"` once per process and binary; `SINTY_BWRAP` overrides the
  lookup (empty = treat as missing; used by the fallback test).

## Rejected alternatives

- Landlock or seccomp from Node: no stable API without a native addon.
- `unshare(1)` / `firejail`: `unshare` needs more manual mounts for the same result; firejail is setuid root.
- Read-only bind of the whole `/` with the home hidden by a tmpfs: leaks everything outside `$HOME` (other users'
  readable files, `/srv`, mounted drives) and depends on where the home is.

## Migration notes

Linux installs where `bwrap` works change behaviour on update: commands lose the network, the user's home and the
environment beyond the list above. Restore the old behaviour with `shell.sandbox: off`, or keep the sandbox and add
`shell.network: true` / `shell.passEnv`. No data migration. Windows and macOS: no change.

## Known limitations

- macOS has no sandbox yet (`sandbox-exec` is deprecated).
- Tool folders on `PATH` are visible read-only, so tools that keep state beside their binaries (some nvm or pyenv
  setups) cannot write there; the workspace is the writable place.
- `HOME` is the workspace, so tools that write dotfiles (`~/.npm`, `~/.cache`) put them into the workspace.
- `/etc` is visible read-only (needed for users, certificates, resolver); it is world-readable on the host anyway.
- Not run on Windows in this change (the Windows branch is untouched); the unsandboxed fallback is covered by a test
  that hides `bwrap` with `SINTY_BWRAP=`.

## How to test

`node --test packages/core/dist/__tests__/shell-sandbox.test.js` (the bwrap tests skip when `bwrap` is missing or
cannot create namespaces): a fake account with `~/.sinty/secrets.json` and `~/notes.txt` — the command works in the
workspace and runs Node, cannot read either file or write outside; `SINTY_SECRET_*` and other variables stay out,
`passEnv` adds one; no network by default, `network: true` reaches a local server; a timeout kills the sandboxed
`sleep`; with `bwrap` hidden, `auto` runs unsandboxed with at most one warning and `bwrap`/strict refuse;
`bwrapArgs` never binds the homes. On the old `shell.ts` the first test fails (the secret file is printed).
By hand: `sinty doctor` shows `ok   shell sandbox: bubblewrap (/usr/bin/bwrap)`.
