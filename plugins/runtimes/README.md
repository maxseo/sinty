# runtimes

One plugin installs the programs HyperFrames needs. FFmpeg, Python and ImageMagick come from winget for the current user (`Gyan.FFmpeg`, `Python.Python.3.12`, `ImageMagick.ImageMagick`).

Chrome is the Chromium Playwright already downloaded for `web.screenshot`, under `%LOCALAPPDATA%\ms-playwright`. It is not on PATH. `hyperframes.render` passes that file as `PUPPETEER_EXECUTABLE_PATH`.

`runtimes.status` reports the paths. `runtimes.install` takes `ffmpeg`, `python`, `magick` or `all`. The sidebar tab Программы shows the same check. A program installed this way shows up in a new terminal; the current one keeps the old PATH.
