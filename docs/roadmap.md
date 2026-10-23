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

## Done after 1.0 (October 2026)

Work done on top of M6, outside the milestones. The plan behind it is [plan.md](plan.md); every change has a
[journal](journal/README.md) entry and a `CHANGELOG.md` entry.

| Change | PR | Journal |
|---|---|---|
| Pluggable memory: `MemoryRouter`, `ModelGateway` (`ctx.models`), memory providers and processors over IPC, `memory-obsidian`, `fact-extractor`, builtin vectors, experiments and `sinty memory eval` (plan steps 0–6) | [#1](https://github.com/maxseo/sinty/pull/1) | `2026-10-19-memory-step-*` |
| Drain the memory `afterTurn` queue before `sinty run` exits | [#2](https://github.com/maxseo/sinty/pull/2) | `2026-10-20-fix-run-drain-memory-queue` |
| Memory limitations: OR/prefix recall, `sinty memory reindex`, journaled tool writes, persistent plugin token budget | [#3](https://github.com/maxseo/sinty/pull/3) | `2026-10-20-memory-*`, `2026-10-20-models-persistent-plugin-budget` |
| Context snapshots, `context-inspector` plugin, plugin UI tabs, «Контекст» in the chat header | [#4](https://github.com/maxseo/sinty/pull/4) | `2026-10-20-plugin-context-inspector` and related |
| Chat agent selection uses the session's agents | [#5](https://github.com/maxseo/sinty/pull/5) | `2026-10-20-fix-chat-agent-selection` |
| Cache-friendly prompt (append-only requests, frozen turn context, provider cache hints) | [#6](https://github.com/maxseo/sinty/pull/6) | `2026-10-20-core-cache-friendly-prompt` |
| Supervisor settings in the Web UI | [#7](https://github.com/maxseo/sinty/pull/7) | `2026-10-20-supervisor-settings-ui` |
| `tool-web` plugin (search, read, screenshot through the core network guard) and follow-ups | [#8](https://github.com/maxseo/sinty/pull/8), [#9](https://github.com/maxseo/sinty/pull/9), [#10](https://github.com/maxseo/sinty/pull/10) | `2026-10-21-tool-web-*`, `2026-10-21-web-errors-supervisor-notices` |
| `skills` loader as a plugin (`ctx.systemSection`) | [#11](https://github.com/maxseo/sinty/pull/11) | `2026-10-21-skills-plugin` |
| Re-embed vectors after an embedding model change (`sinty memory reembed`, `memory.reembed: auto`) | [#12](https://github.com/maxseo/sinty/pull/12) | `2026-10-22-reembed` |
| Stemmed recall (Russian Snowball, English porter) | [#13](https://github.com/maxseo/sinty/pull/13) | `2026-10-22-memory-stemming` |
| Context window from the model list (`memory.contextTokens: auto`), compaction cap `memory.compactCapTokens`, fallback window check | [#14](https://github.com/maxseo/sinty/pull/14) | `2026-10-22-context-window` |
| Login token rotation (`sinty token rotate`, Settings button, `POST /v1/auth/rotate`) | [#15](https://github.com/maxseo/sinty/pull/15) | `2026-10-22-login-token-rotation` |
| No `--allow-child-process` SecurityWarning in plugin logs | [#16](https://github.com/maxseo/sinty/pull/16) | `2026-10-22-child-process-warning` |
| Linux shell sandbox (bubblewrap, `shell.sandbox`) | [#17](https://github.com/maxseo/sinty/pull/17) | `2026-10-22-linux-shell-sandbox` |
| `sinty doctor` reports the capped compaction point | [#18](https://github.com/maxseo/sinty/pull/18) | `2026-10-22-doctor-compaction-cap` |
| Responsive turns: background `agent.task`, `task.completed`, `agent.task_steer`, stop-all, stall pulse, approval queue, `responsive-turn` plugin | [#20](https://github.com/maxseo/sinty/pull/20) | `2026-10-23-responsive-turns` |
| Responsive-turn UX: hide child chats in sidebar, no `trigger=task` after human stop-all, inherit `projectId` | (open) | `2026-10-23-responsive-turn-ux` |

## Known gaps

- Durable `scheduler` plugin (cron / fire-at) is still open; it is not the kanban board. See [backlog](backlog.md#scheduler-plugin-durable-timers--cron--not-kanban).
- In `standard` mode the network allowlist is enforced by the plugin runtime (`fetch` is replaced), not by the OS. A malicious plugin could use `node:net` directly. OS-level control comes with `strict` mode (M5).
- Budgets in USD are not enforced yet (no price table). The compaction point is capped in tokens (`memory.compactCapTokens`), not in money.
- One active turn per session: a second message while the agent is working still returns `409 turn_active`. A message while the turn waits for approval is queued (responsive turns).
- Vector recall is off until an embedding route is configured (`models.routes.embed` is empty by default); recall is full-text only. See [backlog](backlog.md#embeddings-are-not-configured-by-default).
- The shell sandbox covers Linux (bubblewrap) and Windows; macOS runs shell commands without a sandbox.
