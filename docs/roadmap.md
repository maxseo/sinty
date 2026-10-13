# Roadmap

| Milestone | Scope | Status |
|---|---|---|
| **M0 — Spec** | event protocol, journal and recovery, plugin manifest and JSON Schema, policy, supervisor, SDK types, repository | done |
| **M1 — Core** | turn loop, tool registry, policy gate, SQLite journal with resume, plugin host with Node permission model, CLI `init/serve/run/secret/doctor`, HTTP API + SSE; plugins `provider-openai-compat`, `provider-anthropic`, `tool-fs` — **done**. Left: `tool-shell` (sandboxed), `tool-web`, `memory-sqlite`, `skills`, `mcp-stdio` runtime, checkpoints, plugins in `$SINTY_HOME/plugins` resolving `@sinty/sdk` | in progress |
| **M2 — Supervisor and self-repair** | supervisor process, detectors, escalation, incident memory; `plugin.propose_patch` pipeline with tests, canary and rollback; crash tests (kill -9 mid-tool-call) and escape tests (agent tries to write the core) | planned |
| **M3 — Web UI and servers** | Web UI: chat, sessions, journal, approvals, supervisor panel, kanban; AG-UI stream; `server-mcp`, `server-openai-api`, `provider-openai-responses` | planned |
| **M4 — Channels and agents** | `channel-telegram`, `channel-voice`, `channel-webhook`, `server-a2a`, `delegate` (Claude Code / Codex / Grok CLI), `herdr`, `otel` | planned |
| **M5 — Distribution** | single binary (Node SEA), Docker image, `install.sh`, systemd unit, `strict` mode with separate OS users, `sinty upgrade` with integrity check | planned |
| **Known gaps** | in `standard` mode the network allowlist is enforced by the plugin runtime (`fetch` is replaced), not by the OS — a malicious plugin could use `node:net` directly; OS-level egress control comes with `strict` mode (M5). Budgets in USD are not enforced yet (no price table). One active turn per session: a second message returns `409 turn_active` | — |
| **M6 — 1.0** | protocol `sinty/1.0` frozen, plugin registry, docs site | planned |
