# server-agui

An [AG-UI](https://docs.ag-ui.com) endpoint at `POST /p/server-agui/agui` (bearer token). The body is `RunAgentInput`, and the response is a stream of AG-UI events over SSE.

- `threadId` maps to a Sinty session; the map is kept in `$DATA/threads.json`. A `threadId` that is an existing `ses_…` id uses that session.
- Only the newest user message is sent: the agent keeps its own history. `context` items are appended to it.

| Sinty | AG-UI |
|---|---|
| `model.request` / `model.response` | `STEP_STARTED` / `STEP_FINISHED` |
| `model.delta` | `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END` |
| tool calls in `model.response` | `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END` |
| `tool.call.completed/failed/denied` | `TOOL_CALL_RESULT` |
| approvals, supervisor notices and escalations | `CUSTOM` with `name: "sinty.<event type>"` |
| end of the turn | `STATE_SNAPSHOT` with `sessionId` and `status`, then `RUN_FINISHED` or `RUN_ERROR` |

Tools defined by the frontend (`input.tools`) are not executed yet.

Enable it in `config.yaml`: add `server-agui` to `plugins.enabled`.
