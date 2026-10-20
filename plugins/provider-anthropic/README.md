# provider-anthropic

Protocol `anthropic`: `POST {baseUrl}/v1/messages` with streaming, tool use and thinking deltas.

```yaml
providers:
  anthropic: { protocol: anthropic, apiKey: secret://anthropic }
models:
  default: anthropic/<model-id>
```

`baseUrl` defaults to `https://api.anthropic.com`; set it for a gateway. `options` are merged into the request body (for example `thinking`).

## Prompt caching

On by default. The core marks where the stable parts of the prompt end (`ChatMessage.cacheHint`); this plugin turns
those marks into `cache_control` breakpoints (at most 4): the end of the system prompt and skills (this also caches
the tools), the end of the session memory and summary, and the last dialogue message. `system` is sent as text
blocks, and system messages that come after the dialogue starts (context plugins' notes) are sent in place as user
`<system>…</system>` text, so they never rewrite the cached `system`.

Sinty's own options, not sent as is:
- `promptCache: false`: no breakpoints;
- `cacheTtl: "1h"`: the one-hour cache (cache writes cost more) instead of the default five minutes.

`usage.recorded` then has `inputTokens` = the whole prompt (input + cache reads + cache writes), `cachedTokens`
(reads), `cacheWriteTokens` (writes) and `cacheMissTokens` (input + writes). See "Prompt caching" in
`docs/spec/protocol.md`.
