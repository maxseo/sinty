# runtimes

One plugin installs the programs HyperFrames needs. FFmpeg, Python and ImageMagick are downloaded into `%LOCALAPPDATA%\Sinty\tools` (the WindowsApps `winget.exe` alias is not a real program and cannot be started).

Chrome is the Chromium Playwright already downloaded for `web.screenshot`, under `%LOCALAPPDATA%\ms-playwright`. It is not on PATH. `hyperframes.render` passes that file as `PUPPETEER_EXECUTABLE_PATH`.

`runtimes.status` reports the paths. `runtimes.install` takes `ffmpeg`, `python`, `magick` or `all`. The sidebar tab Программы shows the same check. The files live under `%LOCALAPPDATA%\Sinty\tools`.
