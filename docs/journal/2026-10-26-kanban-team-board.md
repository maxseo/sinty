# Kanban rebuilt around a project team

- Date: 2026-10-26
- Area: plugins/kanban, apps/web, skills/kanban-lead
- Plan step: none
- Commits: this commit
- PR: (open)

## Why

The harness board was a single-agent queue (assignee `agent` | `human`, five English columns). Syntet.ru's board is a team board: specialists, a reviewer, dependencies, labels, priority, and a note channel. The n8n conveyor (accept column, minute dispatcher, lead/worker tool split, schedule column, block column) does not fit this core.

## What changed

`plugins/kanban/src/index.ts` stores `assigneeId`, `reviewerId`, `projectId`, `priority`, `label`, `dependsOn`, `notify` (`chat` | `none`). Columns are Бэклог, К выполнению, В работе, Проверка, Готово. A card starts from `todo` or from a drag into `doing` only when it has an assignee and every dependency is in `done`. Leaving `doing` while the worker session is working or blocked calls `agent.interrupt`. `turn.completed` moves the worker card to `review` and, when `reviewerId` is set and is not the author, opens a review session. `kanban.update` to `done` from the author session throws `not_allowed`. `notify: chat` sends `[Канбан #id · title]` into the latest non-child project session via `agent.send`.

`apps/web/src/board.tsx` is the dark-board layout (filters, card, drawer) on the harness light and dark tokens. No column dropdown and no editable project field. Notifications are Чат and Нет only.

Skill `skills/kanban-lead/SKILL.md` tells the lead to read the board, split the backlog, and leave a card unassigned when no specialist exists.

## What was considered and rejected

Messenger connector chips. A separate block column. Auto-accept by the author.

## What is still missing

Old `board.json` cards have no assignee id, so they do not auto-start until someone sets an executor. The team chat is the latest project session, not a dedicated room. A `[Канбан]` note starts a turn in that chat; the skill says not to treat it as new work.
