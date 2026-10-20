# provider-openai-compat

Protocol `openai-compat`: `POST {baseUrl}/chat/completions` with streaming and tool calls.

```yaml
providers:
  xai:      { protocol: openai-compat, baseUrl: https://api.x.ai/v1,        apiKey: secret://xai }
  deepseek: { protocol: openai-compat, baseUrl: https://api.deepseek.com/v1, apiKey: secret://deepseek }
  local:    { protocol: openai-compat, baseUrl: http://127.0.0.1:11434/v1 }
models:
  default: xai/<model-id>
```

`options` on a provider are merged into the request body (for example `temperature`). Reasoning deltas are read from `reasoning_content` (DeepSeek) or `reasoning`.

Network: the manifest allows any host, but the core only lets the plugin reach hosts from `policy.yaml` `net.allow` and the `baseUrl` hosts of providers in `config.yaml`.

## Prompt caching

DeepSeek and OpenAI cache the unchanged start of a request on their own; the core keeps that start byte-identical
between calls (see "Prompt caching" in `docs/spec/protocol.md`). The plugin records the provider's numbers in
`usage.recorded`: DeepSeek `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, OpenAI
`prompt_tokens_details.cached_tokens`, as `cachedTokens` and `cacheMissTokens`.

`options.promptCacheKey` (Sinty's own option, not sent as is): `true` sends `prompt_cache_key` (stable per chat) to
route a conversation to the same cache; `false` never sends it. Unset, it is sent only to `https://api.openai.com`,
because some compatible servers reject unknown fields.
