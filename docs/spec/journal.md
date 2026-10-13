# Journal and recovery

Goal: **a crash at any moment loses no context and repeats no side effect that already happened.**

## Storage

- One SQLite database `journal.db` in WAL mode, `synchronous=FULL` for tool and turn events.
- Tables: `events` (append-only), `sessions` (materialized state), `checkpoints`, `idempotency`, `incidents` (supervisor), `usage`.
- The core is the only writer. Plugins read through the SDK (`ctx.journal.read`), never through the file.
- Optional Postgres adapter for multi-node deployments implements the same interface.

## Write-ahead rules

| Moment | Event written **before** proceeding |
|---|---|
| Before calling the model | `model.request` (messages hash, model, params) |
| After the model answers | `model.response` (full content, tool calls, usage) |
| Before running a tool | `tool.call.started` with `idempotencyKey = hash(turnId, stepId, callId)` |
| After a tool returns | `tool.call.completed` / `tool.call.failed` |
| Turn end | `turn.completed` / `turn.failed` / `turn.interrupted` |

Large payloads (files, images, long tool output) are stored as blobs in `$SINTY_HOME/blobs/<sha256>` and referenced from events.

## Resume algorithm

On start, and after any core crash, for every turn without a terminal event:

1. Rebuild the session state from `checkpoint` + later events.
2. Look at the last step:
   - `model.request` without `model.response` → repeat the model call.
   - `tool.call.started` without a result:
     - tool is `idempotent: true` → run again with the same key;
     - plugin implements `recover(idempotencyKey)` → ask the plugin what happened (e.g. "generation job 123 exists") and journal its answer;
     - otherwise → journal `tool.call.failed { code: "interrupted", hint: "the call may or may not have run" }` and let the model decide, with a supervisor notice.
   - `tool.call.approval_requested` without a decision → stay `blocked`; nothing to do.
3. Journal `turn.resumed` and continue the loop.

## Checkpoints

Every N events (default 200) and at turn end the core writes `checkpoint` with the materialized session state. Replay cost is bounded; full history is never deleted unless the user archives and purges the session.

## Context is a projection

`context` plugins build the prompt from the journal: recent messages verbatim, older ranges summarized, memory facts, skills. Summaries are cached as derived data keyed by the event range. A broken compression plugin falls back to "recent messages that fit the window". The core tool `context.recall({ query | range })` lets the agent pull exact older events back when a summary is not enough.

## Retention

- `events` — kept until the session is purged.
- `model.delta`, `tool.call.progress` — never stored.
- Secrets — redacted before write; the redactor runs in the core, not in plugins.
