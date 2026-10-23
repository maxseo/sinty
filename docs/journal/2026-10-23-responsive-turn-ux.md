# Responsive-turn UX: hide child chats, no restart after stop-all

- Date: 2026-10-23
- Area: `packages/core` (agent), `plugins/responsive-turn`, `apps/web` (sidebar)
- Plan step: post-merge bugfix after PR #20 testing («Тест» chat)
- Commits: this commit
- PR: (open)

## What and why

After merging responsive turns, the «Тест» chat showed two product bugs:

1. Every `agent.task` child appeared in the left sidebar under «Вне проекта» (children had `projectId: null` and the UI listed every session).
2. After «Стоп всё», children were interrupted correctly, then `notifyParentTask` opened a `trigger=task` turn on the idle parent; the model restarted the same work.

## Fix

- **UI:** sidebar chat lists (projects, «Вне проекта», pins) skip sessions whose `metadata.parentSessionId` is set. Pending approvals for children still show so a blocked child can be opened.
- **Core:** `notifyParentTask` still journals `task.completed` with `status: interrupted`, but does **not** launch a trigger=`task` turn and does not enqueue `pendingTaskTurns`. Completed/failed children still wake the parent as before. The next human message still sees the event via dialogue.
- **Core:** child sessions created by `agent.task` inherit the parent's `projectId` (belt-and-suspenders with the UI filter).
- **Plugin:** `responsive-turn` system section tells the model not to restart after an interrupted stop.

## How to test

```bash
pnpm --filter @sinty/core run build
node --test --test-concurrency=1 packages/core/dist/__tests__/responsive-turns.test.js
```

Manual: open a project chat, launch background tasks, confirm children stay out of the sidebar; press «Стоп всё» and confirm the parent does not start new tasks on its own.
