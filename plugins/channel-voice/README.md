# channel-voice

`POST /p/channel-voice/turn` (bearer token): `{ "text", "session_id"? }` → `{ session_id, text, status }`.

The caller does speech-to-text before this and text-to-speech after. This plugin does not open a microphone or call a TTS vendor. That stays a separate service, the same way Alice stays a worker until it is pointed here.

Enable `channel-voice` in `plugins.enabled`.
