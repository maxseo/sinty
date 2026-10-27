# One-shot delay in seconds

- Date: 2026-10-27
- Area: `plugins/scheduler`
- Plan step: scheduler wakes the chat for both a one-shot and a repeat
- Commits: this commit
- PR: (open)

## What and why

A user asked the agent to write a word in 38 seconds. The agent refused: `schedule.create` only accepted a 5-field cron (minute resolution) or an ISO timestamp, and `policy.yaml` treats every write as ask. There is no separate timer.

## Files touched

- `plugins/scheduler/src/index.ts`: `delaySeconds`, `sessionId` defaults to the calling chat, tick fallback 1s, wake text tells the agent to follow the instruction
- `plugins/scheduler/sinty.plugin.json`, `README.md`
- User `policy.yaml`: `schedule.*: allow`

## Design decisions

- One tool, three shapes. `delaySeconds` is a one-shot from now. `at` is a one-shot clock time. `cron` stays the repeat and still cannot name a second.
- Allow, not ask. An approval card spends longer than a 38-second delay.

## Known limitations

- Cron still fires on the minute. "Every 30 seconds" is not a cron.
- The process must be running. A due `at` fires on the next tick after start.
- The wake starts a new turn in that chat. The model then writes the reply.

## How to test

Ask in a chat: «напиши через 38 секунд привет». The tool call should store `delaySeconds: 38` and the same chat should get a new turn about 38 seconds later.
