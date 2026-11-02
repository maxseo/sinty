# Opening a chat no longer waits on tool results

- Date: 2026-11-02
- Area: apps/web, packages/core
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

The transcript was drawn in one piece, and the pane stayed empty until that request finished. «Видео» holds about 150 MB of tool results the chat never draws, so the wait was about three seconds and the header showed the session id. A shorter chat flashed blank for a moment and then popped in.

`/v1/sessions/:id/events` now accepts `types` and returns the session's `lastSeq`. The chat asks only for the events it renders. The stream starts at `lastSeq`, so the old tool results are not replayed. The list is remembered, and the sidebar starts reading chats as soon as it has their names, so switching back paints the messages on the first frame. The header uses the chat's name.

Checked in the browser: «Видео» opened with its name and both ends of the transcript at 17 ms, after the list had been read. «Тест 8» replaced it with the full transcript, with no empty pane in between.

## Files touched

- `packages/core/src/api/server.ts` — `types` and `lastSeq` on the events route
- `apps/web/src/chat.tsx` — load and remember the messages
- `apps/web/src/app.tsx` — pass the chat name and start the reads

## Design decisions

Tool results stay out of this request. The journal view uses the same list, so it does not show those result bodies.

## Rejected alternatives

Keeping the previous chat on screen until the new one arrives. That shows the wrong conversation.

## Migration notes

Refresh the harness once.

## Known limitations

The first open of a chat still waits for its messages. With the results left out, that wait is a fraction of a second, and the following open is the remembered list.
