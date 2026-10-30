# diffusion

The [Diffusion Studio](https://github.com/diffusionstudio/editor) editor runs in the Diffusion tab. The source is `vendor/diffusion-editor` (MPL-2.0), pinned in `COMMIT`. The Electron shell is not used.

`diffusion.run` sends `open`, `context`, `capture`, `check`, `export`, `probe`, `grab`, `transcribe`, `filmstrip`, `waveform`, `listen`, `fonts`, `logs`, `screenshot`, `window` or `job` to that tab. The tab has to be open. `open` takes the absolute project folder, inside the session workspace. `diffusion.generate` asks first.

Sign-in, generation, transcription and listen are not the Diffusion Studio cloud. Put URLs in `$SINTY_HOME/data/diffusion/adapters.json`:

```json
{ "generate": "", "transcribe": "", "listen": "", "account": "" }
```

An empty or missing address answers «не подключено». A set address receives `{ path, input }` as JSON. Supabase, when you want their login screen back, is `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` at editor build time.
