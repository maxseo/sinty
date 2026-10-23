# Bubble agent.task child approvals into the parent chat

- Date: 2026-10-23
- Area: `packages/core` (api), `apps/web` (chat, sidebar)
- Plan step: UX follow-up after hiding child sessions (PR #21)
- Commits: this commit
- PR: (open)

## What and why

After child sessions were hidden from the sidebar, a background `agent.task` that hit
`web.search` (or any approval) only showed up under «Ждут ответа», which opened the
hidden child chat — awkward, and not “in the chat like before”.

## Fix

- `GET /v1/sessions/:id` returns `childPending`: blocked turns of sessions whose
  `metadata.parentSessionId` is this chat.
- `GET /v1/pending` adds `parentSessionId` and `title` for child waits.
- Parent chat renders approval `ToolCard`s for `childPending` and posts decisions to
  the **child** session id. Global `/v1/stream` refreshes the parent when a child blocks.
- Sidebar «Ждут ответа» opens the **parent** chat when the waiter is a child.

## How to test

Manual: project chat → background research that needs `web.search` → approve/deny cards
appear in the parent chat; «Ждут ответа» returns to the parent, not a child journal view.
