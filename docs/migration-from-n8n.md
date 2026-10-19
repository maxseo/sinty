# Migrating from n8n

Sinty replaces agent workflows built in n8n (chat webhook → AI agent node → tools → memory) with one process. Switching happens **last**, after the Web UI, the `syntet` plugin, channels and packaging. Until then Sinty runs on its own (laptop or VPS). n8n stays until each workflow is switched off.

## Map workflows to plugins

| n8n building block | Sinty |
|---|---|
| Webhook trigger for chat | `channel-webhook` or `POST /v1/sessions/:id/messages` |
| AI Agent node + tools | the core turn loop + tool plugins |
| HTTP Request nodes to your API | one domain plugin with typed tools |
| Memory nodes (Postgres, Supabase, Redis) | a `context` memory plugin on the same tables |
| Schedule trigger / Cron | `scheduler` plugin (durable, survives restarts) |
| Wait / polling loops | durable timers + `recover()` in the tool plugin |
| Error workflow | supervisor + a notification plugin |
| Token counting nodes | `usage.recorded` events + a billing `event` plugin |
| Telegram / voice triggers | channel plugins |

## Strangler steps (milestone M7, last)

1. **Keep the contracts.** Point a `channel-webhook` route at the same request and response shape as the n8n webhook. Your backend changes only the URL.
2. **Feature flag per workflow.** For example `AGENT_CHAT_BACKEND=n8n|sinty|shadow`.
3. **Shadow mode.** Send the request to both; return the n8n answer; journal and compare the Sinty answer and tool calls.
4. **Switch.** Flip the flag for one workflow at a time; keep n8n as fallback for a week.
5. **Remove.** Disable the n8n workflow; delete the flag.

## Connecting an agent to your system

1. `sinty init` on the machine (laptop or VPS).
2. Issue an agent token in your system and run `sinty connect <your-url> --token <token>`.
3. The agent publishes its Agent Card; your system stores it with the agent record.
4. The agent keeps an outbound connection (WebSocket or SSE) with heartbeats — no inbound ports are needed, so a laptop behind NAT works.
5. The agent subscribes to its kanban columns or projects; cards arrive as tasks.
6. Skills from your system sync to `skills/` as `SKILL.md`.
