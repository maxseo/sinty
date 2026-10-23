---
name: background-tasks
description: When to run agent.task in the background vs in the same turn (RU/EN).
---

# Background tasks (`agent.task`)

## When NOT to use `background: true` (default)

- Short factual answers, one search, one page read, a quick calculation.
- Any sub-step where you need the child's result before your next sentence to the human.
- The human did not ask to keep chatting or to work "in the background".

Omit `background` or set `false`: the parent turn waits for the child.

## When to use `background: true`

- The human said so: «в фоне», «пока я…», «не жди», "in the background", "keep chatting", "don't wait".
- Clearly long research (many URLs/sites) and they need the parent chat free meanwhile.

Then: short ack → `agent.task({ background: true, … })` → continue. When `task.completed` arrives, summarise once.

## Approvals

Tool calls still go through policy and the journal. If the human wrote «не спрашивай» / "just do it" / «разрешаю всё», the session may skip `ask` prompts; `deny` still blocks.

## See also

Plugin `responsive-turn` injects a short system rule; this skill is the fuller reference (`skill.read background-tasks`).
