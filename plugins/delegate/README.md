# delegate

Tool `delegate.run` `{ program, prompt }`. Default programs: `claude -p`, `codex exec`, `grok -p`. The prompt is the last argument. Only names listed in config are allowed; there is no shell.

Override in `config.yaml`:

```yaml
plugins:
  config:
    delegate:
      commands:
        echo: ["node", "-e", "process.stdout.write(process.argv.at(-1) ?? '')"]
      timeoutMs: 60000
```

Policy default is `ask`. The plugin has `shell: true`, so its process may spawn children. It cannot write the workspace itself.

Enable `delegate` in `plugins.enabled`.
