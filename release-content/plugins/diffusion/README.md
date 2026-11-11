# diffusion

The [Diffusion Studio](https://github.com/diffusionstudio/editor) editor runs inside each harness project, on the Видео tab. That tab lists the films of the open project and opens the editor for one of them. Their own project dashboard is not used. The source is `vendor/diffusion-editor` (MPL-2.0), pinned in `COMMIT`. The Electron shell is not used.

`diffusion.run` sends one command to the film open beside the chat. `context` lists the scenes (`id` like `index.tsx:2`) and the assets (a library path like `clip.mov`). `check`, `capture` and `export` use the open scene when no id is given. Picture commands write PNGs under the chat project's `_out/diffusion` and return the path. `export` writes `_out/film.mp4` there unless a path is given. `diffusion.source` reads or replaces `index.tsx`, or copies a chat-project file into the film library. `window` reports that the pane is visible. `logs` is empty. `diffusion.generate` asks first. The skill `diffusion-editor` is the working loop.

Sign-in, generation, transcription and listen are not the Diffusion Studio cloud. Put URLs in `$SINTY_HOME/data/diffusion/adapters.json`:

```json
{ "generate": "", "transcribe": "", "listen": "", "account": "" }
```

An empty or missing address answers «не подключено». A set address receives `{ path, input }` as JSON. Supabase, when you want their login screen back, is `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` at editor build time.

The film compiler is `compiler/` next to this plugin (`npm install` there). It has to sit inside the plugin directory: the plugin process may not read the repository. Import media copies the file into the film's `assets/` folder. The browser does not reveal the path of a picked file.
