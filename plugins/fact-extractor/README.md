# fact-extractor

Memory processor, disabled by default.

- **afterTurn** — after each completed turn the core queues a job (durable, once per turn). The plugin asks the
  `cheap` model route (`models.routes.cheap`, else `service.model`, else `models.default`) through `ctx.models` for at
  most `maxFacts` durable facts as JSON and returns them; the core writes them through the normal write path
  (`memory.written` with `source: fact-extractor`). Usage is journaled in the session (`models.called`,
  `usage.recorded`) and counts against `models.pluginTokensPerDay`.
- **onWrite** — for every memory write (tool, summary, extraction): drops text that looks like a credential
  (API keys, private keys, `password: …`, long hex/base64 tokens), drops fragments shorter than `minChars` that did not
  come from the agent's own `memory.write`, collapses whitespace and caps length at `maxChars`.

## Enable

```yaml
plugins:
  enabled: [..., fact-extractor]
models:
  routes:
    cheap: openai/gpt-4o-mini
```

The manifest asks only for `permissions.models: ["cheap"]`.
