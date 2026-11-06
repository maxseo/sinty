# hyperframes

Agents write a HyperFrames composition and render it with the [hyperframes](https://github.com/heygen-com/hyperframes) CLI.

`hyperframes.write` saves `index.html` in the current session workspace at `hyperframes/<slug>/`: `workspace/projects/<slug>/hyperframes` in a project chat, or `workspace/hyperframes` when there is no project (then the session root is the global workspace). `hyperframes.render` runs `npx hyperframes render` there and copies the mp4 to `_out/video/<slug>/film.mp4`. Older compositions that still live only under the global `hyperframes/` folder can still be rendered. The machine needs Node 22, FFmpeg and Chrome. A render stops after three minutes.

The sidebar tab Hyperframes asks npm and GitHub for the current release. The first check stores that version. A later check lights the indicator when the npm version or the `main` commit changed. «Установить» or «Обновить» installs that npm version for the next render. «Отметить просмотренным» stores the new mark without installing. The same tab lists compositions from the global `hyperframes/<slug>` folder and from each project's `hyperframes/<slug>`: a preview frame, the name, the stage size, «Открыть» for the video or the HTML, and «Удалить».
