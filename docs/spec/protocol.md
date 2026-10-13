# Events and API protocol

Version: `sinty/0.1` (draft). TypeScript types: [`packages/sdk/src/events.ts`](../../packages/sdk/src/events.ts).

## Event envelope

Every journal entry and every streamed event uses one envelope:

```json
{
  "id": "01JA9X2W5K6Y3Q8R0T1V4M7N2P",
  "seq": 1842,
  "ts": "2026-10-14T01:20:00.000Z",
  "sessionId": "ses_01JA...",
  "turnId": "trn_01JA...",
  "stepId": "stp_01JA...",
  "type": "tool.call.failed",
  "actor": { "kind": "plugin", "id": "syntet" },
  "causationId": "01JA9X2W...",
  "data": { "callId": "call_7", "code": "http_422", "message": "...", "hint": "..." }
}
```

- `id` — ULID, globally unique.
- `seq` — strictly increasing per session; clients resume streams with `?after=<seq>`.
- `actor.kind` — `human | agent | supervisor | system | plugin`.
- `causationId` — the event that caused this one.

## Event types

| Group | Types |
|---|---|
| Session | `session.created`, `session.updated`, `session.archived` |
| Turn | `turn.started`, `turn.completed`, `turn.failed`, `turn.interrupted`, `turn.blocked`, `turn.resumed` |
| Messages | `message.user`, `message.agent`, `message.channel` |
| Model | `model.request`, `model.delta` *(stream only, not journaled)*, `model.response`, `model.fallback` |
| Tools | `tool.call.requested`, `tool.call.approval_requested`, `tool.call.approved`, `tool.call.denied`, `tool.call.started`, `tool.call.progress` *(stream only)*, `tool.call.completed`, `tool.call.failed` |
| Supervisor | `supervisor.notice`, `supervisor.escalated`, `supervisor.incident_resolved` |
| Agent state | `agent.state` with `idle | working | blocked | done | error` |
| Plugins | `plugin.loaded`, `plugin.crashed`, `plugin.patch.proposed`, `plugin.patch.tested`, `plugin.patch.applied`, `plugin.patch.rolled_back` |
| Accounting | `usage.recorded` (tokens, cost, provider, model) |
| Recovery | `checkpoint` |

Agent states match Herdr's vocabulary so integrations need no mapping.

## HTTP API

Base path `/v1`. Auth: `Authorization: Bearer <token>`; scopes `read`, `chat`, `approve`, `admin`.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/v1/health` | — | liveness and readiness |
| GET | `/v1/agent` | read | agent card: name, skills, tools, models, channels |
| POST | `/v1/sessions` | chat | create a session `{ title?, projectId?, metadata? }` |
| GET | `/v1/sessions` | read | list sessions |
| GET | `/v1/sessions/:id` | read | session with current state |
| POST | `/v1/sessions/:id/messages` | chat | send a user message; starts a turn; returns `{ turnId }` |
| GET | `/v1/sessions/:id/events?after=<seq>` | read | replay journaled events |
| GET | `/v1/sessions/:id/stream?after=<seq>` | read | SSE stream: replay then live |
| POST | `/v1/sessions/:id/approvals/:callId` | approve | `{ decision: "approve" | "deny", note? }` |
| POST | `/v1/sessions/:id/interrupt` | chat | stop the current turn after the running step |
| GET | `/v1/ws` | read | WebSocket multiplex of all sessions the token can see |

Plugins add surfaces: `/mcp` (`server-mcp`), `/.well-known/agent-card.json` and `/a2a` (`server-a2a`), `/v1/chat/completions` and `/v1/responses` (`server-openai-api`).

## AG-UI mapping

`/stream?format=ag-ui` emits AG-UI events so any AG-UI client can render Sinty:

| Sinty | AG-UI |
|---|---|
| `turn.started` / `turn.completed` / `turn.failed` | `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR` |
| `model.delta` | `TEXT_MESSAGE_CONTENT` (between `TEXT_MESSAGE_START` and `TEXT_MESSAGE_END`) |
| `tool.call.started` / `tool.call.completed` | `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT` |
| `agent.state`, `supervisor.notice` | `STATE_DELTA`, `CUSTOM` |

## Idempotent message delivery

`POST /messages` accepts `Idempotency-Key`. A repeated key returns the original `turnId` without starting a second turn. Channels (Telegram webhooks, n8n-compatible webhooks) use this to survive retries.
