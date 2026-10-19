# herdr

Writes every `agent.state` to `$DATA/states.jsonl`. If `plugins.config.herdr.url` is set, the same JSON is POSTed there. States use the same names as the journal: `idle`, `working`, `blocked`, `done`, `error`.

Enable `herdr` in `plugins.enabled`.
