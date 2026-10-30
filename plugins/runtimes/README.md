# runtimes

One plugin installs the programs HyperFrames needs. FFmpeg, Python and ImageMagick are downloaded into `%LOCALAPPDATA%\Sinty\tools` (the WindowsApps `winget.exe` alias is not a real program and cannot be started). The tab answers at once and the download continues in the background: the core stops an HTTP handler that has not started its response within two minutes, which is shorter than the FFmpeg zip.

Chrome is the Chromium Playwright already downloaded for `web.screenshot`, under `%LOCALAPPDATA%\ms-playwright`. It is not installed here. `hyperframes.render` passes that file as `PUPPETEER_EXECUTABLE_PATH` and prepends the tool bins onto `PATH`.

`runtimes.status` reports the paths and whether an install is still running. `runtimes.install` takes `ffmpeg`, `python`, `magick` or `all`, and skips a program that is already present. The sidebar tab Программы shows one row per program, an Установить button on each missing row, and Установить все. A finished install is added to the user PATH.
