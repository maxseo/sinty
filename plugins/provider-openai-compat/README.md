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
