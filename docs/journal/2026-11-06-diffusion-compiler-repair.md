# A film compiles after a broken compiler junction

- Date: 2026-11-06
- Area: plugins/diffusion
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

Opening any film showed «Project failed to compile. компилятор не найден» and an empty timeline. Assets still listed, so the editor UI was running. `compilerPackage()` returned nothing because `usableCompiler` could not resolve `esbuild` from `compiler/package.json`.

On the machine this came from, the home plugin at `%USERPROFILE%\.sinty\plugins\diffusion` had `compiler/node_modules` as a junction to `AppData\Local\Sinty\app\plugins\diffusion\compiler\node_modules`. That target was gone after the packaged app moved. The source checkout at `plugins/diffusion/compiler` still had a real `node_modules`. Home plugins are searched before bundled ones, so the broken copy won.

This is independent of writing HyperFrames under the session root. That change does not touch diffusion.

## Files touched

- `plugins/diffusion/src/host.ts` — `usableCompiler` and `compilerPackage` are exported; a one-shot repair removes a broken `compiler/node_modules` and runs `npm ci` from the lockfile in an unconfined child (the plugin process cannot write its own folder). `SINTY_INSTALL_ROOT/plugins/diffusion/compiler` is also a candidate.
- `plugins/diffusion/src/host-compiler.test.ts` — lookup cases, including a skipped bad `compiler.json` note
- `plugins/diffusion/package.json` — `test` script
- `plugins/diffusion/README.md` — note about the repair

## Design decisions

Repair only when `package.json` and `package-lock.json` are both present, and only once per process. The compile child is not confined by `--permission`, but the parent check still has to resolve `esbuild` itself before it starts that child.

## Rejected alternatives

Pointing `compiler.json` at the repository compiler. The plugin process may not read that path, which is how this error first appeared. Widening `--allow-fs-read` to the whole checkout was rejected earlier. Replacing the home plugin with the bundled one would drop local editor edits.

## Migration notes

A running home copy that already has this bug can be repaired without waiting for the new build: delete the dangling `compiler/node_modules` junction and run `npm ci --omit=dev` in that `compiler/` folder, then restart Sinty and reopen the film.

## Known limitations

`npm ci` needs network the first time a broken folder is repaired. If npm is missing, the toast stays «компилятор не найден».

## How to test

`pnpm --filter @sinty/plugin-diffusion test`. On the harness: open any film on Видео; the canvas and timeline should load without the compile toast.
