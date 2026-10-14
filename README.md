# Sinty

**Syntet AI agent that runs the same on a laptop and on any VPS.**
One process, one SQLite file, plugins for everything else.

> Status: **v0.2, core and supervisor working** — turn loop, journal with crash recovery, policy gate, sandboxed plugin host, HTTP API with SSE, CLI, providers for OpenAI-compatible APIs and Anthropic, file tools, a supervisor that sends the agent hints and escalates to a human, and a patch pipeline through which the agent fixes its own plugins (sandboxed tests, git history, automatic rollback). The Web UI is next. See [roadmap](docs/roadmap.md).

[Русская версия](README.ru.md)

---

## Why Sinty

| | |
|---|---|
| **Thin core** | The core is only: the turn loop, the tool registry with JSON Schema validation, policies, a durable event journal and the plugin host. ~Everything else is a plugin. |
| **Plugins & skills** | Model providers, file/shell/web tools, memory, context compression, channels (Web, Telegram, voice), the Web UI, kanban, scheduling — all plugins. Skills are plain `SKILL.md` files. |
| **The agent can improve itself — but never its core** | The agent may rewrite plugins and skills through a tested, reversible patch pipeline. The core, policies and secrets are out of reach at the tool and OS level, not by prompt. |
| **Survives crashes without losing context** | Every step is journaled before and after it runs. Kill the process mid-tool-call and the turn resumes from the same step. Context compression never loses data: the journal is the source of truth, the prompt is a projection. |
| **A supervisor watches every step** | A system process catches failing steps, loops, timeouts and budget overruns and tells the agent: *"look at this, think, here are the docs, propose a fix"* — then escalates to a human if needed. |
| **Industry standards, not new formats** | MCP, A2A, AG-UI, ACP, Agent Skills (`SKILL.md`), `AGENTS.md`, OpenAI-compatible API, OpenTelemetry. If you know Claude Code, Codex or Hermes, you already know how to use Sinty. |
| **Any model** | OpenAI-compatible (xAI Grok, DeepSeek, Ollama, vLLM, OpenRouter…), OpenAI Responses and Anthropic Messages protocols, with fallback routing. |
| **Any interface** | The core speaks a protocol; the bundled Web UI (chat, kanban, journal, supervisor panel) is just one client. Telegram, Herdr, your own app, Claude/ChatGPT/Grok via MCP — all equal clients. |

## Run from source (works today)

```sh
git clone https://github.com/maxseo/sinty.git && cd sinty
corepack enable && pnpm install && pnpm build      # Node.js 24+
alias sinty="node $PWD/packages/cli/dist/bin.js"   # PowerShell: function sinty { node "$PWD\packages\cli\dist\bin.js" @args }

sinty init                          # prints the API token once
sinty secret set deepseek           # or anthropic, openai, xai
# set models.default in ~/.sinty/config.yaml, e.g. deepseek/deepseek-chat
sinty doctor
sinty run "create notes/todo.md with three ideas for my weekend"
sinty serve                         # HTTP API on 127.0.0.1:3180
```

```sh
curl -X POST localhost:3180/v1/sessions -H "Authorization: Bearer $TOKEN" -d '{}'
curl -X POST localhost:3180/v1/sessions/<id>/messages -H "Authorization: Bearer $TOKEN" -d '{"text":"hi"}'
curl -N localhost:3180/v1/sessions/<id>/stream -H "Authorization: Bearer $TOKEN"
```

## Quick start (target distribution)

> Packaged install arrives with milestone M5.

```sh
# local machine (Windows, macOS, Linux) — Node.js 24+
npx sinty init          # creates ~/.sinty with config, policy and a git repo for plugins
npx sinty web           # starts the agent and opens http://127.0.0.1:3180

# VPS
curl -fsSL https://raw.githubusercontent.com/maxseo/sinty/main/install.sh | sh
sinty init --mode strict   # separate OS users for core and agent
sinty service install      # systemd unit, auto-restart

# Docker
docker run -d -p 3180:3180 -v sinty:/data ghcr.io/maxseo/sinty
```

Add a model in **Settings → Models** or in `~/.sinty/config.yaml`:

```yaml
providers:
  xai:       { protocol: openai-compat, baseUrl: https://api.x.ai/v1, apiKey: secret://xai }
  anthropic: { protocol: anthropic,     apiKey: secret://anthropic }
  openai:    { protocol: openai-responses, apiKey: secret://openai }
  local:     { protocol: openai-compat, baseUrl: http://127.0.0.1:11434/v1 }

models:
  default:  anthropic/<model-id>
  fallback: [xai/<model-id>, openai/<model-id>]
  cheap:    local/<model-id>      # used by plugins for summaries, classification
```

`secret://` values live in the encrypted secret store (`sinty secret set xai`) and never enter the model context.

## How it works

```
                    ┌──────────────────── clients ────────────────────┐
                    │ Web UI · Telegram · Herdr · MCP clients (Claude,│
                    │ ChatGPT, Grok) · A2A agents · OpenAI API clients│
                    └───────────────────────┬─────────────────────────┘
                                            │ HTTP · SSE · WebSocket (AG-UI events)
┌─────────────────────────── PROTECTED CORE ┴─────────────────────────────────┐
│  turn loop ── tool registry (JSON Schema) ── policy gate (allow/ask/deny)   │
│      │                                                                      │
│  event journal (SQLite WAL, append-only) ── resume · checkpoints · idem keys│
│      │                                                                      │
│  plugin host (isolated processes, hot reload, rollback) ── event bus ── API │
│                                                                             │
│  supervisor (separate process) ── detectors · notices · escalation          │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ plugin protocol (in-process SDK or MCP stdio)
   ┌──────────┬──────────┬──────┴─────┬───────────┬───────────┬─────────────┐
 providers   tools     memory      context     channels     servers      domain
 (models)  fs·shell·  sqlite·     compress·   web·telegram  mcp·a2a·    kanban·
           web·mcp    supabase    skills      voice·herdr   openai-api  your apps
                     ── AGENT-EDITABLE through the patch pipeline ──
```

Read more: [architecture](docs/architecture.md).

## The core is protected — how exactly

Sinty does not *ask* the model to leave the core alone; the model has no path to it.

1. **Separate locations.** The core is installed read-only (`/opt/sinty`, `Program Files`, or the npm cache). The agent's writable roots are `skills/` and `workspace/` only.
2. **Plugins run isolated.** Each plugin runs in its own process under the Node.js permission model (`--permission`, `--allow-fs-write=<own dir>`), with network and secrets granted per manifest. In `strict` mode the core and the agent run as different OS users.
3. **`plugins/` is changed only through the patch pipeline.** The built-in `plugin.propose_patch` tool creates a git branch, runs the plugin's tests in a sandbox, applies the change with hot reload, health-checks it and rolls back automatically on failure.
4. **The agent cannot widen its own rights.** `policy.yaml`, `config.yaml`, secrets and the journal belong to the core. Any patch that changes a plugin's permissions requires human approval.
5. **Integrity check.** The core verifies its file hashes on start. Only a human updates it: `sinty upgrade`.

Details: [policy spec](docs/spec/policy.md), [plugin patch pipeline](docs/spec/plugin-manifest.md#patch-pipeline).

## The supervisor

A separate system process subscribed to the event bus. It detects:

- tool errors and invalid arguments,
- loops (the same call repeated N times),
- timeouts and stalled steps,
- step / token / money budget overruns,
- empty, truncated or malformed model output,
- provider degradation.

On detection it injects a notice into the agent's context:

```text
[supervisor] Pay attention: step 14, tool syntet.generate_image failed with HTTP 422.
Think about what is wrong with the arguments. Tool docs: <excerpt from the plugin manifest docs>.
A similar incident was solved by: <incident memory>. Propose a fix.
```

Escalation ladder: **hint → change strategy or model → propose a plugin patch → stop and ask a human** (the turn becomes `blocked`, a card appears in the "Needs decision" kanban column). Resolved incidents are remembered and reused. Spec: [supervisor](docs/spec/supervisor.md).

## Writing a plugin

```ts
import { definePlugin, z } from "@sinty/sdk";

export default definePlugin({
  name: "weather",
  setup(ctx) {
    ctx.tool({
      name: "weather.now",
      description: "Current weather for a city",
      input: z.object({ city: z.string() }),
      sideEffects: "none",
      async run({ city }, { signal }) {
        const r = await ctx.net.fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { signal });
        return { content: await r.json() };
      },
    });
  },
});
```

Every MCP server is also a valid Sinty tool plugin (`"runtime": "mcp-stdio"`), so plugins can be written in any language. See [plugin manifest](docs/spec/plugin-manifest.md) and [`plugins/example-echo`](plugins/example-echo).

## Integrations

| With | How |
|---|---|
| **Grok, ChatGPT, Claude as models** | provider plugins: `openai-compat`, `openai-responses`, `anthropic` |
| **Sinty inside Claude Desktop / Claude Code, ChatGPT, Grok** | `server-mcp` plugin exposes Sinty's skills, kanban and tasks as an MCP server |
| **Claude Code, Codex, Grok CLI as Sinty's sub-agents** | `delegate` plugin over ACP or CLI |
| **Other agents** | `server-a2a` plugin: Agent Card at `/.well-known/agent-card.json`, tasks over A2A |
| **Any OpenAI SDK client** | `server-openai-api` plugin: `/v1/chat/completions`, `/v1/responses` |
| **Herdr** | `herdr` plugin reports `working` / `blocked` / `idle` and the resume command |
| **Editors (Zed and others)** | ACP |
| **Telegram, voice assistants** | channel plugins |

Details: [integrations](docs/integrations.md).

## Repository layout

```
packages/
  core/         turn loop, registry, policies, journal, plugin host, API
  supervisor/   supervisor process
  sdk/          types and helpers for plugin authors   ← contracts live here
  cli/          sinty init | web | run | upgrade | doctor | secret
plugins/        bundled plugins (each has sinty.plugin.json)
skills/         bundled SKILL.md skills
apps/web/       Web UI: chat, kanban, agents, journal, supervisor
schemas/        JSON Schemas for manifests and config
docs/           architecture, specs, integrations, roadmap
```

## Documentation

- [Architecture](docs/architecture.md)
- Specs: [events & API protocol](docs/spec/protocol.md) · [journal & recovery](docs/spec/journal.md) · [plugin manifest & patch pipeline](docs/spec/plugin-manifest.md) · [policy](docs/spec/policy.md) · [supervisor](docs/spec/supervisor.md)
- [Integrations](docs/integrations.md)
- [Migrating from n8n](docs/migration-from-n8n.md)
- [Roadmap](docs/roadmap.md)
- [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Rules for coding agents](AGENTS.md)

## Inspired by

[Hermes Agent](https://github.com/NousResearch/hermes-agent) (self-improving skills, multi-channel gateway) ·
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (everything-is-a-plugin, Web UI) ·
[Herdr](https://herdr.dev) (agent state you can see and wait on).

## License

[MIT](LICENSE)
