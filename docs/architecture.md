# Architecture

## Principles

1. **Thin core, fat plugins.** The core holds only what is needed to stay correct, safe and recoverable. Everything that can be swapped is a plugin.
2. **The journal is the truth; the prompt is a projection.** The model context is rebuilt from the journal on every step by `context` plugins. Compression, memory and RAG can be replaced or broken without losing data.
3. **Protocol first.** Every client — including the bundled Web UI — talks to the core through the same public API.
4. **Standards over inventions.** MCP, A2A, AG-UI, ACP, Agent Skills, `AGENTS.md`, OpenAI-compatible API, OpenTelemetry.
5. **The model is untrusted.** Safety is enforced by the runtime and the OS, never by the prompt.

## Core components

| Component | Responsibility |
|---|---|
| **Turn loop** | `context.build → provider.call → tool calls → results → repeat` until the model stops, a budget runs out, or the turn is blocked or interrupted |
| **Tool registry** | Tool definitions with JSON Schema input, `sideEffects` and `idempotent`; argument validation before any call; a single error shape |
| **Policy gate** | `allow` / `ask` / `deny` per tool, path, host and budget; approvals from authenticated clients only |
| **Journal** | Append-only SQLite (WAL) event log; checkpoints; idempotency keys; resume after crash |
| **Plugin host** | Discover, validate, start, isolate, hot-reload and roll back plugins |
| **Event bus + API** | Internal pub/sub; external HTTP, SSE and WebSocket |
| **Supervisor** | Separate process that watches the bus and intervenes (see [spec](spec/supervisor.md)) |
| **Core tools** | `ask_human`, `context.recall`, `plugin.list`, `plugin.read`, `plugin.propose_patch`, `plugin.apply_patch`; these cannot be overridden by plugins |

Nothing else is in the core. In particular, these are plugins: model providers, file and shell tools, web search, memory, context compression, skills loader, channels, the Web UI, kanban, scheduler jobs, MCP/A2A/OpenAI servers.

## Extension points

Plugins attach to a small fixed set of extension points:

| Point | Plugin kind | Example |
|---|---|---|
| `provider` | model protocol adapter | `provider-anthropic` |
| `tool` | callable tools | `tool-fs`, `syntet` |
| `context` | contribute to or transform the prompt built from the journal | `memory-sqlite`, `context-compress`, `skills` |
| `channel` | inbound and outbound messages | `channel-telegram`, `channel-web` |
| `server` | additional HTTP surfaces at `/p/<plugin>/…` | `server-mcp`, `server-openai-api`, `server-agui` |
| `schedule` | durable timers and cron jobs | `scheduler` (backlog) |
| `event` | subscribe to bus events (read-only) | `kanban`, later `herdr`, `otel` |
| `ui` | static bundle served at `/ui/<plugin>/` (non-editable only) | `ui-web` |

## Runtime layout

```
<install dir>            read-only core: packages/core, supervisor, cli, sdk
$SINTY_HOME/             default ~/.sinty, or /var/lib/sinty on a VPS
  config.yaml            core-owned: providers, models, plugins, server
  policy.yaml            core-owned: permissions, budgets, approvals
  AGENTS.md              core-owned: agent rules (agent may propose edits, human approves)
  secrets.json           core-owned: secrets, AES-256-GCM
  secret.key             core-owned: key for secrets.json
  journal.db             core-owned: events, checkpoints, incidents
  data/<plugin>/         plugin-owned; `$DATA` in the manifest, isolated per plugin
  plugins/               git repo; changed only through plugin.propose_patch
  skills/                agent-writable
  workspace/             agent-writable; per-project subfolders
```

## Modes

| Mode | Use | Isolation |
|---|---|---|
| `standard` | laptop, single user | Node.js permission model per plugin process |
| `strict` | VPS, shared hosts | separate OS users for core (`sinty-core`) and plugins (`sinty-agent`), plus the permission model; shell in a container |

## Process model

```
sinty (core process)
 ├─ supervisor            child process, restarted by core
 ├─ plugin: provider-*    one process per plugin (or worker thread for trusted, read-only plugins)
 ├─ plugin: tool-*
 └─ ...
```

The core restarts crashed plugins with backoff. A plugin crash fails only the current tool call (`tool.call.failed`, code `plugin_crashed`), never the turn loop.

## Data flow of one step

1. `context.build` — the core reads the journal for the session and passes it through `context` plugins in order (memory, skills, compression). Output: messages + tool list.
2. `model.request` journaled → `provider.call` streams deltas to clients → `model.response` journaled.
3. For each tool call: validate → policy gate (may emit `tool.call.approval_requested` and block) → `tool.call.started` journaled with idempotency key → plugin runs → `tool.call.completed` or `tool.call.failed` journaled.
4. Supervisor reads the same events and may journal `supervisor.notice`, which the next `context.build` includes.
5. Repeat until the model returns no tool calls → `turn.completed`.
