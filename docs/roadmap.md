# Roadmap

Milestones in order. Smaller items without a milestone are in the [backlog](backlog.md), each with what it gives the agent.

| Milestone | Scope | Status |
|---|---|---|
| **M0 — Spec** | event protocol, journal and recovery, plugin manifest and JSON Schema, policy, supervisor, SDK types, repository | done |
| **M1 — Core** | turn loop, tool registry, policy gate, SQLite journal with resume, plugin host with Node permission model, CLI `init/serve/run/secret/doctor`, HTTP API + SSE; plugins `provider-openai-compat`, `provider-anthropic`, `tool-fs` | done |
| **M2 — Supervisor and self-repair** | supervisor process with detectors `tool_error`, `invalid_args`, `loop`, `budget`, `bad_output`, `interrupted`; escalation to a human; incident memory; budgets block the turn instead of failing it; `plugin.list/read/propose_patch/apply_patch` with sandboxed tests, git history, canary and rollback | done |
| **M3 — Web UI and servers** | HTTP routes and agent access for plugins (`$DATA`, `/p/<plugin>`, `/ui/<plugin>` for non-editable); Web UI: chat, sessions, journal, approvals, supervisor panel, kanban; AG-UI, MCP and OpenAI-compatible servers; `provider-openai-responses` | done |
| **M4 — Channels and agents** | `channel-webhook`, `channel-telegram`, `channel-voice` (text in/out), `server-a2a` `message/send`, `delegate` (allowlisted CLI), `herdr`, `otel` (JSON lines); plugin `syntet` (`whoami`, `generations`, `record_usage`). `ctx.channel()` is still a stub; these plugins use HTTP and tools | done |
| **M5 — Distribution** | directory install (`scripts/stage.mjs`, `install.ps1`, `install.sh`), Docker image, systemd unit, `sinty upgrade` checks `integrity.json`, `init --mode strict` refuses to run as root on Linux. A single SEA binary is not shipped: plugins are loaded from disk | done |
| **M6 — 1.0** | protocol `sinty/1.0` frozen; `registry/plugins.json` and `sinty plugins`; docs page `site/index.html` | done |
| **M7 — Switch from n8n** | shadow mode next to n8n (both answer, n8n's answer is returned, Sinty's is journaled and compared), switch one workflow at a time with n8n as fallback, then remove the n8n workflows. See [migration](migration-from-n8n.md) | planned, last |

## Known gaps

- In `standard` mode the network allowlist is enforced by the plugin runtime (`fetch` is replaced), not by the OS. A malicious plugin could use `node:net` directly. OS-level control comes with `strict` mode (M5).
- Budgets in USD are not enforced yet (no price table).
- A second message during a running turn joins that turn. A turn waiting for approval still returns `409 turn_active`.
