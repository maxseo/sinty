# provider-openai-responses

The `openai-responses` protocol: `POST {baseUrl}/responses` with `stream: true` and `store: false`. Nothing is stored on OpenAI's side, and the full history is sent each turn, the same way as with the other providers.

- System messages become `instructions`; tool calls and results become `function_call` and `function_call_output` items.
- Provider `options` are merged into the request body as is. Use them to set reasoning effort or verbosity. Reasoning summaries show up as reasoning deltas.

```yaml
providers:
  openai:
    protocol: openai-responses
    baseUrl: https://api.openai.com/v1
    apiKey: secret://openai
    options:
      reasoning: { effort: medium, summary: auto }
models:
  default: openai/gpt-5
```

Enable it in `config.yaml`: add `provider-openai-responses` to `plugins.enabled`.

## Prompt caching

`instructions` hold only the leading system messages (system prompt, skills, session memory); system messages that
come later (context plugins' notes) stay in place as `developer` items, so the cached instructions do not change
between calls. `prompt_cache_key` (stable per chat) is sent unless `options.promptCacheKey` is `false`. Cached input
is recorded as `cachedTokens` and `cacheMissTokens` in `usage.recorded`.
