# Integrations

## Models

| Protocol plugin | Covers |
|---|---|
| `provider-openai-compat` | xAI Grok, DeepSeek, OpenRouter, Groq, Together, Ollama, vLLM, LM Studio, any `/v1/chat/completions` gateway |
| `provider-openai-responses` | OpenAI Responses API |
| `provider-anthropic` | Anthropic Messages API, Claude via Bedrock/Vertex gateways |

Routing in `config.yaml`: `default`, `fallback[]`, and named routes (`cheap`, `vision`, `long`) that plugins can request. The supervisor switches to the next fallback on provider errors.

## Sinty as a tool for other assistants (MCP server)

Plugin `server-mcp` exposes `/mcp` (Streamable HTTP) and `sinty mcp` (stdio):

- tools: `sinty.ask` (run a turn and return the answer), `sinty.task.create`, `sinty.task.status`, plus selected plugin tools;
- resources: sessions, journal excerpts, skills.

Connect it to Claude Desktop / Claude Code, ChatGPT connectors, Grok (remote MCP in the xAI API), Cursor, or any MCP client.

```json
{ "mcpServers": { "sinty": { "command": "sinty", "args": ["mcp"] } } }
```

## Other agents as tools (MCP client)

Any MCP server is a plugin with `"runtime": "mcp-stdio"` or `"http"` — see [plugin manifest](spec/plugin-manifest.md#mcp-servers-as-plugins).

## Sub-agents: Claude Code, Codex, Grok CLI

Plugin `delegate` runs coding agents as sub-agents in a workspace folder, via ACP (Agent Client Protocol) when supported or via CLI otherwise. Tool `delegate.run({ agent, prompt, cwd, timeout })` returns the result and a transcript reference. Under Herdr the sub-agent runs in a Herdr pane and its state is visible there.

## A2A

Plugin `server-a2a` publishes an Agent Card at `/.well-known/agent-card.json` (skills from `skills/`, auth scheme) and accepts A2A tasks. Kanban cards map to A2A tasks one-to-one, so external agents can be assigned cards and Sinty can assign cards to them.

## OpenAI-compatible API

Plugin `server-openai-api` serves `/v1/chat/completions` and `/v1/responses`. `model` selects the Sinty agent (`sinty/<agent-id>`). Lets any OpenAI SDK client, chat UI or no-code tool talk to Sinty unchanged.

## Herdr

Plugin `herdr` activates when `HERDR_BIN_PATH` is set. On every `agent.state` it calls:

```sh
"$HERDR_BIN_PATH" pane report-agent --agent sinty --state working --resume-command "sinty attach <sessionId>"
```

and releases the pane on exit. Sinty's states are the same as Herdr's (`idle`, `working`, `blocked`, `done`).

## Channels

| Plugin | Notes |
|---|---|
| `channel-web` | the bundled Web UI; also the reference AG-UI client |
| `channel-telegram` | long polling locally, webhook on a VPS; approvals as inline buttons |
| `channel-voice` | voice assistants (Yandex Alice, etc.) via webhook skills |
| `channel-webhook` | generic inbound webhook with `Idempotency-Key`; drop-in for n8n webhook URLs |

## Observability

Plugin `otel` exports traces with OpenTelemetry GenAI semantic conventions: one span per turn, child spans per model call and tool call, token usage as attributes.
