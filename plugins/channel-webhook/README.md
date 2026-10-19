# channel-webhook

`POST /p/channel-webhook/hook` with the Sinty bearer token. Body: `{ "text" }` or `{ "message", "chat_id"?, "session_id"? }`. Waits for the turn and returns `{ session_id, text, status }`. The same `chat_id` keeps one session (`$DATA/chats.json`). `Idempotency-Key` is forwarded.

Enable `channel-webhook` in `plugins.enabled`. This is the stand-in for the n8n chat webhook; the site changes only the URL. Shadow mode (both backends) is milestone M7.
