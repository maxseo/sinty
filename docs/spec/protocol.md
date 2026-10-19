# Events and API protocol

Version: `sinty/1.0` (frozen). TypeScript types: [`packages/sdk/src/events.ts`](../../packages/sdk/src/events.ts).

Frozen means a client written for 1.0 keeps working. New optional fields and new event types may appear. Renaming or removing a field, or changing the meaning of an existing one, requires `sinty/2.0`. `GET /v1/health` returns this version.

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

Base path `/v1`. Auth: `Authorization: Bearer <token>` (or `?token=` on GET, stripped before a plugin sees the request). One token today; finer scopes are in the [backlog](../backlog.md).

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/health` | liveness and protocol version |
| GET | `/v1/registry` | catalog of shipped plugins and which are enabled |
| GET | `/v1/agent` | name, default model, tools, plugins, supervisor flag |
| GET | `/v1/plugins` | installed plugins, their tools, HTTP routes and UI path |
| POST | `/v1/sessions` | create `{ title?, projectId?, metadata? }` |
| GET | `/v1/sessions` | list with `activeTurn` |
| GET | `/v1/sessions/:id` | session plus `pending` (approvals / ask_human / supervisor / budget) |
| GET | `/v1/sessions/:id/pending` | pending info for one session |
| GET | `/v1/pending` | every blocked turn across sessions |
| POST | `/v1/sessions/:id/messages` | user message; starts a turn; `{ turnId }` |
| GET | `/v1/sessions/:id/events?after=<seq>` | replay journaled events |
| GET | `/v1/sessions/:id/stream?after=<seq>` | SSE: replay then live (includes `model.delta`) |
| POST | `/v1/sessions/:id/approvals/:callId` | `{ decision: "approve" \| "deny", note? }` |
| POST | `/v1/sessions/:id/interrupt` | stop the current turn after the running step |
| GET | `/v1/supervisor` | recent supervisor events, incidents, patches (file paths only) |
| GET | `/v1/stream` | SSE of lifecycle events of all sessions (lists, badges, boards) |
| GET | `/` | redirect to `/ui/<server.ui>/` |
| GET | `/ui/:plugin/*` | static UI of a **non-editable** plugin |
| * | `/p/:plugin/*` | HTTP routes the plugin registered; public routes skip the token |

Plugin surfaces (enable the plugin in `config.yaml`):

| Plugin | Path |
|---|---|
| `server-mcp` | `POST /p/server-mcp/mcp` |
| `server-openai-api` | `GET /p/server-openai-api/v1/models`, `POST …/v1/chat/completions` |
| `server-agui` | `POST /p/server-agui/agui` |
| `kanban` | `/p/kanban/board`, `/stream`, `/cards` |

## AG-UI mapping

`POST /p/server-agui/agui` (plugin `server-agui`) accepts `RunAgentInput` and streams AG-UI events. `threadId` maps to a Sinty session.

| Sinty | AG-UI |
|---|---|
| start / end of the turn | `RUN_STARTED` / `RUN_FINISHED` or `RUN_ERROR` |
| `model.request` / `model.response` | `STEP_STARTED` / `STEP_FINISHED` |
| `model.delta` | `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END` |
| tool calls | `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT` |
| approvals, supervisor | `CUSTOM` with `name: "sinty.<event type>"` |

## Idempotent message delivery

`POST /messages` accepts `Idempotency-Key`. A repeated key returns the original `turnId` without starting a second turn. Channels (Telegram webhooks, n8n-compatible webhooks) use this to survive retries.
