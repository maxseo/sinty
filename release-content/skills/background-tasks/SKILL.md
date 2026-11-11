---
name: background-tasks
description: When to run agent.task in the background vs in the same turn (RU/EN).
---

# Background tasks (`agent.task`)

Count the job before the first tool call. These numbers are the same ones in the `responsive-turn` system section and in `docs/journal/2026-11-09-background-thresholds.md` — change all three together.

## Stay in this turn

- No tool needed: just answer.
- At most 2 tool calls, and at most 1 page, file or site to read.

Omit `background` or set `false`: the parent turn waits for the child. This is the right choice when the human needs the answer inside this same reply.

## Send it to the background yourself

Do this without waiting for the human to say «в фоне» / "in the background", as soon as any of these is true:

- 3 or more tool calls.
- 2 or more pages, files or sites to read.
- 2 or more independent threads — one background `agent.task` per thread, up to the parallel limit (3 by default).
- The job cannot finish inside this turn: a download, a build, a long playlist, many edits in a row.

Then: one short acknowledgement, `agent.task({ background: true, … })`, and finish the parent turn so the human can talk. When `task.completed` arrives, summarise once. A correction to a running child is `agent.task_steer`, not a second copy of the same task. A child stopped by the supervisor or the budget is a pause: do not start a replacement, the child turn is still open.

## Approvals

Tool calls still go through policy and the journal. If the human wrote «не спрашивай» / "just do it" / «разрешаю всё», the session may skip `ask` prompts; `deny` still blocks.

## Changing this rule

The rule lives in three places: this file, the `responsive-turn` system section and the journal entry linked above. The audit trail and the revert procedure are documented in `docs/journal/2026-10-26-background-by-size.md`; keep that kind of note out of the system section, the model must not read how to undo its own rule.

## See also

Plugin `responsive-turn` injects the short system rule; this skill is the fuller reference (`skill.read background-tasks`).
