# tool-listen

`audio.listen` asks a chat model about the sound of a file in the project. ffmpeg strips the picture and writes a 16 kHz mono mp3 in the plugin's own data folder, then the file is deleted. The answer is text: music, speakers, events, approximate times.

Speech written out word for word, with word times, is `stt.transcribe`. Pictures are `vision.look`.

## Route

1. `plugins.config.tool-listen.modelRoute` if set (Settings → Аудио), else
2. `models.routes.listen`

Pick the route in Settings → Models, row **listen — разбор звука**. The model has to accept audio (`input_audio`). A text-only model refuses the clip. Speech-to-text stays on the `stt` row.

## Call

- `path` — one audio or video file, relative to the project
- `prompt` — the question. Empty asks for a description with times
- `start`, `end` — seconds. A file longer than Max length (default 10 minutes) needs this window
