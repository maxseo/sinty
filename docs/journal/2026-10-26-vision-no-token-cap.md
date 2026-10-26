# vision.look: no output cap, reasoning off by default

Chat «Тест 8» (`ses_01M5VNA2BVZQZ053N9FN8JY6HX`) failed `vision.look` with `empty_vision` on dense page scans. The side call always sent `maxOutputTokens: 1200`. `deepseek-flash` spends that budget on `reasoning_content`, so `content` comes back empty and the plugin throws.

## What changed

- `plugins/tool-vision`: `maxOutputTokens` is gone from the manifest, settings and `ctx.models.complete`. `reasoning` is a boolean, default `false`. On sends `reasoning: "medium"`.
- `ModelGateway.pluginCall` no longer invents a 2000-token cap when the plugin omits `maxOutputTokens`. An explicit cap is still clamped to `models.maxOutputTokens`. `reasoning` is forwarded.
- `provider-openai-compat` `buildBody`: `reasoning: "off"` on `api.deepseek.com` sets `thinking: { type: "disabled" }` and does not set `reasoning_effort`. Other hosts are unchanged, so OpenAI does not receive `thinking`.

## Still true

The main turn still uses `models.maxOutputTokens`. A message sent while a turn is running is appended to that turn and is not answered until the model stops calling tools. Text that arrives in the same response as tool calls is not stored as `message.agent`.
