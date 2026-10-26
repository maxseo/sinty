# Stop stays available while a child is blocked

Typing «остановить все» starts a new parent turn. It does not call `stopAll`. The «Стоп всё» button was shown only while the parent turn status was `running`, so it disappeared once the parent had answered, while supervisor-blocked children stayed in «Ждут ответа».

## What changed

- `GET /v1/sessions/:id` adds `childBusy`: how many `agent.task` children still have a `running` or `blocked` turn.
- The button stays while the open chat is `running` or `blocked`, or `childBusy` is greater than zero. It still posts `stop-all`.
- Each «Ждут ответа» row has ×. It posts `interrupt` for that session only, so a blocked child ends without a new model turn and without stopping its siblings.

## Revert

Drop `childBusy` from `packages/core/src/api/server.ts`, restore `{running && (` around the button in `apps/web/src/chat.tsx`, and remove the × button in `apps/web/src/app.tsx`.
