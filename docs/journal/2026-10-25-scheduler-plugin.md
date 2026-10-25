# Scheduler plugin: durable cron / fire-at wakes

- Date: 2026-10-25
- Area: `plugins/scheduler`, `registry/plugins.json`, docs backlog/roadmap
- Plan step: harness roadmap — scheduler after MCP / fetch_file; foundation for channels/digests and M7 n8n exit
- Commits: this commit
- PR: (open)

## What and why

Channels and n8n migration need fire-at / cron that survive restarts and wake an agent without a human in chat.
Kanban is a board; `agent.task` background children are in-process and session-scoped. This plugin is the missing
`kind: schedule` slice: durable jobs + a tick loop while Sinty runs + a clear journal trail.

## Files touched

- `plugins/scheduler/*`: cron parser, `$DATA/jobs.json` store, tools, HTTP `/jobs` + `/wakes`, README
- `registry/plugins.json`, `docs/backlog.md`, `docs/roadmap.md`, `CHANGELOG.md`

## Design decisions

- **Plugin-only.** Host `ctx.schedule()` stays a stub; the agent registers jobs through tools, not static plugin
  callbacks. Matches "plugins over core".
- **Wake via `agent.send(..., { channel: "schedule" })`.** Journal shows `turn.started` + `message.user` with
  `channel: "schedule"` and a `[scheduler] Job …` prefix. No core change for `trigger: "schedule"` in this slice.
- **Opt-in (not DEFAULT_ON).** Operators enable `scheduler` when they want wakes; avoids surprising token spend.
- **Tick 10s (config `tickMs`).** Cron matches local wall-clock minute; same-minute idempotency key + `lastRunAt`
  prevent double fire. Overdue `at` jobs fire on the next tick after start; missed cron minutes while down are not
  backfilled (next matching minute only).
- **Policy ask on `schedule.create`.** Creating a recurring wake spends future turns.

## Rejected alternatives

- Stretching kanban into a scheduler (explicitly rejected in backlog / responsive-turns journal).
- Implementing host `ctx.schedule` first: useful for static plugin crons, not for agent-registered durable jobs.
- Default-on: premature until digests/channels land.

## Migration notes

- Enable with `plugins.enabled: […, scheduler]` or Settings → Plugins. No config migration.
- Jobs live under `$SINTY_HOME/data/scheduler/`.

## Known limitations

- No fire while the process is stopped (except overdue `at` on boot).
- `turn.started.trigger` remains `"message"`; identity is `channel: "schedule"`.
- No Settings UI pane, no channel approval wiring, no USD budgets.
- `ctx.schedule()` SDK stub unchanged.

## How to test

```bash
pnpm --filter @sinty/plugin-scheduler test
```

Manual: enable plugin → create session → `schedule.create` with `at` a minute ahead (or cron `* * * * *`) →
watch journal for `channel: "schedule"` and `GET /p/scheduler/wakes`.
