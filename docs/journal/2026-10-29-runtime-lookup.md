# Program status looked only at PATH

The programs tab said Chrome was missing. Playwright's Chromium is on disk, and the plugin process is not given LOCALAPPDATA, so a folder read failed and was reported as absent. Diffusion only told the person to install the app.

## What changed

Status searches the disk from a child process: WinGet packages, the Python folder, and `ms-playwright`. HyperFrames render uses that Chrome path. The Diffusion tab downloads `Diffusion-Studio-x64-Setup.exe` and runs it.

## Why

The red lines were a failed lookup, and the editor tab had no installer.
