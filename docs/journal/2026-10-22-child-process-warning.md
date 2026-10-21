# Silence the --allow-child-process SecurityWarning, by code and per process

- Date: 2026-10-22
- Area: `packages/core/src/host/host.ts`
- Plan step: overnight item 5
- Commits: this commit

## What and why

Every start of `tool-web` produced a warn log line from the plugin's stderr:
`(node:…) [PERM0002] SecurityWarning: The flag --allow-child-process must be used with extreme caution. It could
invalidate the permission model.` plus Node's `(Use node --trace-warnings …)` hint. `tool-web` declares
`permissions.browser` (Playwright Chromium), so the host starts it with `--allow-child-process`; the same applies to
plugins with `permissions.shell` and to `mcp-stdio` plugins. The warning repeats a grant the manifest already declares
and the human enabled, and it trains people to ignore warn lines.

`PluginProcess.permissionArgs()` now adds `CHILD_PROCESS_WARNING_OFF` (`--disable-warning=PERM0002`) right next to
`--allow-child-process`, and only then. `PluginProcess.start()` logs one info line instead:
`may start child processes (permissions.browser); the Node permission model does not confine them`. The new getter
`childProcesses` holds the condition that used to be inline.

## Files touched

- `packages/core/src/host/host.ts`: `CHILD_PROCESS_WARNING_OFF`, `childProcesses`, `childProcessReason()`, the info line.
- `packages/core/src/__tests__/child-process-warning.test.ts` (new, 2 tests).
- `docs/spec/plugin-manifest.md`, `CHANGELOG.md`.

## Design decisions

- `--disable-warning` takes a warning code as well as a type. Node 24 gives this warning the code `PERM0002`
  (checked on 24.22.0: `process.on("warning")` reports `name SecurityWarning, code PERM0002`), so only that one
  message goes away. `--allow-worker` (`PERM0006`) or any other SecurityWarning would still show.
- Per process, not global: the core process and plugins without child processes keep every warning;
  `process.removeAllListeners("warning")` or `--no-warnings` were not used.
- Filtering the stderr text in the host was rejected: stderr arrives in arbitrary chunks, and matching message text
  breaks when Node rewords it; the code is stable.
- The plugin-test runner in `patches.ts` reuses `permissionArgs()`, so plugin test runs are quiet in the same way.

## Rejected alternatives

- `--disable-warning=SecurityWarning`: would hide unrelated security warnings too.
- `--no-warnings` / `NODE_NO_WARNINGS=1`: hides everything, including deprecations a plugin author needs.

## Migration notes

None.

## Known limitations

- On a Node 24 release where this warning has no code, the flag is a no-op and the warning shows as before
  (harmless). Not checked on Windows; the flag is platform-independent.

## How to test

`node --test packages/core/dist/__tests__/child-process-warning.test.js`: starts `fake-provider` and `tool-web`,
checks that no warn line or PERM0002 text comes from `tool-web` and that the info line appears once; checks that a
plugin without child processes gets neither flag; spawns Node with the same flags and checks that another
SecurityWarning (`TEST0001`) and a DeprecationWarning still print. With the code changed to a dummy warning code both
tests fail.
