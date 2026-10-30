# diffusion

Agents edit video in [Diffusion Studio](https://github.com/diffusionstudio/editor). A project is a folder of Solid JSX. The agent writes those files with `fs.write`, then calls `diffusion.run` with `open` on that folder. The desktop app compiles the JSX onto the canvas, and canvas edits are written back into the same files.

`diffusion.run` wraps the app CLI: `open`, `context`, `capture`, `check`, `export`, `probe`, `grab`, `transcribe`, `filmstrip`, `waveform`, `listen`, `fonts`, `logs`, `screenshot`, `window`, `job`. Paths stay in the session workspace. `diffusion.generate` spends account credits and asks first.

The command `diffusion` ships with the desktop app. The sidebar tab says whether `Diffusion Studio.exe` is installed, shows the latest GitHub release, downloads the Windows setup when the app is missing, and opens the editor window.
