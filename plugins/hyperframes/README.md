# hyperframes

Agents write a HyperFrames composition and render it with the [hyperframes](https://github.com/heygen-com/hyperframes) CLI.

`hyperframes.write` saves `index.html` in the session workspace at `hyperframes/<slug>/`. `hyperframes.render` runs `npx hyperframes render` there. The machine needs Node 22, FFmpeg and Chrome. A render stops after three minutes.

The sidebar tab Hyperframes asks npm and GitHub for the current release. The first check stores that version. A later check lights the indicator when the npm version or the `main` commit changed. «Отметить просмотренным» stores the new mark. `hyperframes.updates` returns the same comparison.
