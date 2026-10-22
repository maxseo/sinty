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

## Shell sandbox

Approval decides whether `shell.run` may run a command; the sandbox decides what the command can reach. The
working directory always stays inside the workspace, and `assertSandbox` refuses commands that name a path outside it.

| Platform | Sandbox |
|---|---|
| Windows | `ShellBox.exe`: an AppContainer without capabilities (no network); the workspace and a copy of Node are granted. Unchanged by `config.yaml` `shell` |
| Linux | bubblewrap (`bwrap`), see below |
| macOS | none yet: the command runs as the user |

On Linux (`packages/core/src/shell-sandbox.ts`) the command runs as `bwrap … /bin/sh -c <command>` with:

- `/usr`, `/bin`, `/sbin`, `/lib*`, `/etc`, `/opt` read-only, an empty `/tmp`, private `/dev` and `/proc`;
- the folder of the Node that runs Sinty and the absolute folders on `PATH` read-only, except a folder that contains
  the workspace, `$SINTY_HOME` or `$HOME`, or one inside `$SINTY_HOME`;
- the workspace read-write; `HOME` points at it; the user's home, `secrets.json`, `memory.db`, SSH keys are not there;
- all namespaces unshared (`--unshare-all`, `--new-session`, `--die-with-parent`), so no network unless
  `shell.network: true`;
- a cleared environment: `PATH`, `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `TERM`, `TZ`, plus
  `shell.passEnv`; `SINTY_SECRET_*` is never passed.

```yaml
shell:
  sandbox: auto      # auto (default) | bwrap | off
  network: false     # let commands reach the network
  passEnv: []        # extra environment variable names
```

`auto` uses bubblewrap when `bwrap` is on `PATH` and can create namespaces (probed once per process). When it cannot,
the **fallback** is: in `mode: standard` the command runs without a sandbox, as before, and the core logs one warning
per process; in `mode: strict`, or with `sandbox: bwrap`, `shell.run` fails with `sandbox_unavailable` and the hint
to install bubblewrap (`apt install bubblewrap`, `dnf install bubblewrap`) or set `shell.sandbox: off`. Containers
and kernels that forbid unprivileged user namespaces (`kernel.unprivileged_userns_clone=0`, Ubuntu 24.04 AppArmor
`restrict_unprivileged_userns`) fail the probe; there, run Sinty itself in a container, or allow bwrap in AppArmor.
`sinty doctor` prints which case applies.
