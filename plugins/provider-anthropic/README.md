# provider-anthropic

Protocol `anthropic`: `POST {baseUrl}/v1/messages` with streaming, tool use and thinking deltas.

```yaml
providers:
  anthropic: { protocol: anthropic, apiKey: secret://anthropic }
models:
  default: anthropic/<model-id>
```

`baseUrl` defaults to `https://api.anthropic.com`; set it for a gateway. `options` are merged into the request body (for example `thinking`).
