# Policy

`$SINTY_HOME/policy.yaml` is owned by the core. No tool can write it. Changes take effect on the next step.

```yaml
mode: standard            # standard | strict

defaults:                 # by tool sideEffects
  none: allow
  read: allow
  write: ask
  external: ask

tools:                    # exact name or glob; overrides defaults
  "fs.read": allow
  "fs.write": allow       # still limited by paths.write
  "shell.*": ask
  "syntet.*": allow
  "plugin.propose_patch": allow   # writes only to a staging copy and tests it
  "plugin.apply_patch": ask       # permission changes always ask, whatever this says

paths:
  read:  ["$WORKSPACE/**", "$SKILLS/**", "$PLUGINS/**"]
  write: ["$WORKSPACE/**", "$SKILLS/**"]

net:
  allow: ["api.x.ai", "api.openai.com", "api.anthropic.com", "api.deepseek.com", "syntet.ru", "*.syntet.ru"]

budgets:
  turn:    { steps: 60, tokens: 600000, usd: 3, seconds: 1200 }
  session: { usd: 20 }
  day:     { usd: 50 }

approvals:
  channels: [web, telegram]   # where approval requests are shown
  timeout: 24h
  onTimeout: deny

agents:                     # per-agent overrides when one core hosts several agents
  designer:
    tools: { "shell.*": deny }
```

## Evaluation order

1. Core hard rules (cannot be configured): no writes outside declared roots, no access to `config.yaml`, `policy.yaml`, `secrets.db`, `journal.db`, the install dir.
2. `agents.<id>` overrides.
3. `tools` entries, most specific match first.
4. `defaults` by `sideEffects`.
5. Plugin manifest `defaultPolicy` is only a suggestion shown in the UI when the plugin is installed.

`deny` always wins. Budgets are checked before every model call and every tool call; exceeding one blocks the turn with `supervisor.escalated`.

## Approvals

An `ask` call journals `tool.call.approval_requested` and the turn enters `blocked`. Only an authenticated client with the `approve` scope can decide. Text from the model, tool output or inbound channel messages can never approve anything.
