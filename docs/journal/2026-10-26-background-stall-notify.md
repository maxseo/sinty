# A stalled background child tells the parent

`notifyParentTask` runs only from `endTurn`. A supervisor or budget stop calls `block` and leaves the child turn open, so the parent kept the last «Фон · работает» line and never got a `task.completed` wake. In «Тест 8» three children sat in «Ждут ответа» while the parent chat looked busy.

## What changed

- `Agent.block`: a background child blocked for `supervisor` or `budget` records `task.progress` phase `blocked` on the parent (tool name and the error) and one `task.completed` with status `failed`. The text says the turn is still open and must not be started again. `agent.task_steer` still works: the child stays registered. A second block of the same turn does not notify again until `resume`.
- The parent chat line stays «Фон · стоит …» until the parent model answers. Then it clears, same as a finished background task.
- `plugins/responsive-turn` tells the model that this failure is a pause, not a cue to launch a replacement.

## Revert

Remove `notifyParentStalled` and the `stalledTurns` set from `packages/core/src/agent.ts`, drop phase `blocked` from `packages/sdk/src/events.ts` and `apps/web/src/chat.tsx`, and drop the pause sentence in `plugins/responsive-turn/src/index.ts`.
