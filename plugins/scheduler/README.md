# scheduler

Durable **cron** and **fire-at** jobs for Sinty. While the harness is running, due jobs wake a
session with `message.user` (`channel: "schedule"`) so the agent can work without a human in chat.

Not kanban. Not `agent.task` background children. Foundation for digests / channels and later M7 n8n exit.

## Enable

Opt-in (not default-on):

```yaml
plugins:
  enabled:
    - …existing…
    - scheduler
```

Or Settings → Plugins → enable **scheduler**. Restart / hot-reload as usual.

## Tools

| Tool | Purpose |
|---|---|
| `schedule.create` | `cron` **or** `at` + `sessionId` + `text` (policy **ask**) |
| `schedule.list` | jobs with `lastRunAt` / `nextRunAt` |
| `schedule.cancel` | remove by id |

Cron is five fields: `minute hour dom month dow` (local wall clock). Examples: `*/5 * * * *`, `0 9 * * 1-5`.

## HTTP (plugin routes)

- `GET /p/scheduler/jobs` — list jobs + `tickMs`
- `GET /p/scheduler/wakes` — last ~100 wake log lines (`$DATA/wakes.jsonl`)

## See a wake in the journal

1. Enable the plugin; open a chat and note its `sessionId`.
2. Ask the agent (or call the tool) to create a near-term job, e.g. fire-at a minute ahead, or cron `* * * * *`.
3. Wait for the tick (default 10s). Journal shows `turn.started` then `message.user` with `channel: "schedule"` and text starting `[scheduler] Job …`.
4. Confirm with `GET /p/scheduler/wakes` or `schedule.list` (`lastRunAt`, `runCount`).

Jobs persist under `$SINTY_HOME/data/scheduler/jobs.json` across restarts; they only fire while Sinty is up.

## Limits (this slice)

- No fire when the process is down (catch-up on boot for overdue `at`; cron fires on the next matching minute after start).
- `ctx.schedule()` in the SDK host remains a stub — this plugin owns timers + tools.
- `turn.started.trigger` stays `"message"`; wake identity is `channel: "schedule"` (core trigger=`schedule` later if needed).
- No Telegram / channel approvals, no USD budgets, no Settings UI pane yet.
