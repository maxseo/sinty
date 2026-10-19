# kanban

A board with columns **Backlog → To do → In progress → Review → Done**. Stored in `$SINTY_HOME/data/kanban/board.json`.

- A card assigned to the **agent** in *To do* is a queued task. Up to `maxParallel` (default 3) cards run at the same time, each in its own session.
- When the turn finishes, the card moves to *Review*. A human comment on a card in *Review* sends it back to *To do* with the comment as feedback.
- Moving a running card out of *In progress* interrupts the agent.
- The agent can list cards, create cards and comment on them. Cards it creates are assigned to the human: only a human can give work to the agent.

## Tools

| Tool | Arguments |
|---|---|
| `kanban.list` | `column?` — one of `backlog`, `todo`, `doing`, `review`, `done`; `id?` — one card with description and comments |
| `kanban.create` | `title`, `description?`, `column?` (default `backlog`) |
| `kanban.update` | `id`, `comment?`, `column?` — the agent cannot move a card to `doing` |

## HTTP (`/p/kanban`, bearer token)

| Route | Does |
|---|---|
| `GET /board` | columns and cards |
| `GET /stream` | SSE: `board` event with a full snapshot on every change |
| `POST /cards` | `{ title, description?, column?, assignee? }` |
| `PATCH /cards/:id` | `{ title?, description?, column?, assignee?, order?, comment? }` |
| `DELETE /cards/:id` | delete; interrupts the agent if it is working on the card |
| `POST /cards/:id/start` | assign to the agent and start now |

## Config

```yaml
plugins:
  config:
    kanban: { maxParallel: 3 }
```
