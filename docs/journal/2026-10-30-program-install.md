# Program install used a winget path that is not a file

The programs button spawned `%LOCALAPPDATA%\Microsoft\WindowsApps\winget.exe`. That path is an app-execution alias and the file is not there, so the spawn returned ENOENT and the other two programs were never tried. Diffusion's tab said the command was found and did not open the editor window. The app is already at `%LOCALAPPDATA%\DiffusionStudio\Diffusion Studio.exe`.

## What changed

`runtimes.install` downloads FFmpeg (gyan essentials zip), Python 3.12 (official installer into `Sinty\tools\python`) and ImageMagick 7.1.2-34 portable (7z via `7zr.exe`) into `%LOCALAPPDATA%\Sinty\tools`, then the status search looks there. The Diffusion tab shows whether the editor exe exists and a button starts it detached so the window appears.

## Why

winget is not installed as a real executable on this machine. The person asked where the video editor window is; a status sentence does not open it.
