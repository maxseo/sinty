---
name: background-tasks
description: When to run agent.task in the background vs in the same turn (RU/EN).
---

# Background tasks (`agent.task`)

## Stay in this turn

- Short factual answers, one search, one page read, a quick calculation.
- One or two tool calls whose result you need before the next sentence.

Omit `background` or set `false`: the parent turn waits for the child.

## Send it to the background yourself

Do this without waiting for the human to say «в фоне» / "in the background". Decide from the size of the work:

- Many steps, many pages, files, or sites.
- Several independent threads (split them, up to the parallel limit).

Then: one short acknowledgement, `agent.task({ background: true, … })`, and finish the parent turn so the human can talk. When `task.completed` arrives, summarise once. A correction to a running child is `agent.task_steer`, not a second copy of the same task.

## Approvals

Tool calls still go through policy and the journal. If the human wrote «не спрашивай» / "just do it" / «разрешаю всё», the session may skip `ask` prompts; `deny` still blocks.

## Revert

This skill used to require an explicit human request before `background: true`. To restore that, put the "only when the human asked" rule back here and in `plugins/responsive-turn/src/index.ts`. The note is `docs/journal/2026-10-26-background-by-size.md`.

## See also

Plugin `responsive-turn` injects the short system rule; this skill is the fuller reference (`skill.read background-tasks`).
