# Background by size, not by an explicit request

The 2026-10-23 rule told the model to set `agent.task` `background: true` only when the human asked («в фоне», "don't wait") or the research was obviously long. Long work then stayed in the parent turn, and a message sent while tools were running was appended to that turn instead of answered.

## What changed

The model now decides from the size of the work. A short answer or one or two tool calls stay in the parent turn. Many steps, pages, files, or independent threads go to `background: true` without waiting for the human to say so. The parent sends a short acknowledgement and ends the turn, so the next human message starts a new turn. Corrections use `agent.task_steer`.

Same text in three places, because the model reads all of them:

- `plugins/responsive-turn/src/index.ts` system section (the last bullet names this file)
- `skills/background-tasks/SKILL.md`
- `packages/core/src/coretools.ts` description of `agent.task` and its `background` field

## Revert

Put back the sentence "Set background: true ONLY when the human explicitly asked…". The old skill text is in git history of `skills/background-tasks/SKILL.md` before this entry. Do not revert the core background machinery (`task.completed`, steer, stop-all); only the prompt rule.
