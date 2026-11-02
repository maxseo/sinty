# The film stays open beside the chat, and the cut is saved

- Date: 2026-11-02
- Area: apps/web, plugins/diffusion, vendor/diffusion-editor
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

Checking an agent command required the film to be open, and opening the chat unmounted the editor. The cut lived only in memory ([Film preview](2026-10-30-film-preview.md) left that limit in place), so coming back showed an empty timeline. Assets were the only thing on disk.

«Видео» is now a button in the chat header, to the left of the agent picker. It opens the editor in a pane to the right of the chat, hides the left navigation the same way the collapse button does, and gives the chat one fifth of the screen. The editor stays mounted while the person types. The project tree no longer lists a second Видео entry.

Inside the editor, the Chat tab is gone (the harness chat is the one beside the film). The menu trigger says «Меню». «Synt Studio», «Go to dashboard», «AI credits» and «Account» are not shown.

A canvas edit is written into the film’s `index.tsx`. The writer applies insert, set, move and remove in the same tag order the compiler stamps, and returns those stamps so the open timeline keeps the clip. Reopening the film reads the file, so the cut is still there. Loop unroll and variable edits are skipped; the editor puts those back itself.

## Files touched

- `apps/web/src/app.tsx`, `apps/web/src/chat.tsx`, `apps/web/src/style.css` — the Видео button, the right pane, and the collapsed navigation
- `plugins/diffusion/compiler/write.cjs`, `plugins/diffusion/src/host.ts` — `projects:write` saves the cut
- `vendor/diffusion-editor/apps/web/src/components/sidebar-left/project-menu/index.tsx` — menu items
- `vendor/diffusion-editor/apps/web/src/components/sidebar-left/sidebar-left.tsx`, `apps/web/src/agent-chat/sidebar-tabs.tsx`, `apps/web/src/agent-chat/store.ts` — no second chat, no «Synt Studio»

## Design decisions

The pane is the same project tab iframe, kept next to the chat instead of replacing it. Closing «Видео» unmounts it; the file is what brings the cut back.

The writer emits the lowercase tags the compiler already rewrites. It does not try to reprint the official desktop writer, which was not vendored.

## Rejected alternatives

Leaving the editor mounted forever, including after the button is turned off. The person asked for a pane they can open, and a reload still has to restore the cut from the file.

## Migration notes

Ctrl+F5. «Видео» is in the chat header. A film that was only edited in memory before this change is still the empty stage; edits made after this build are in `index.tsx`.

## Known limitations

The writer covers the cut (clips, moves, property changes, deletes). It does not unroll a loop or rewrite a variable. Two editor panes open at once can still take each other’s tool calls.
