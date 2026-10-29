# Agents can drive Diffusion Studio

Diffusion Studio is a video editor whose document is Solid JSX. The desktop app ships a `diffusion` command. The harness had no tool for it.

## What changed

Plugin `diffusion`. `diffusion.run` calls the allowlisted CLI commands inside the workspace. The agent writes the JSX with `fs.write` and opens the folder. `diffusion.generate` is a separate tool and asks before it spends credits. The sidebar tab reports whether the command exists and the latest GitHub release. The plugin does not download the app.

## Why

The agent should edit the same project a person opens in Diffusion Studio.
