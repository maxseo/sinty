# Scheduler month calendar and UI Kit in Settings

- Date: 2026-10-26
- Area: `plugins/scheduler`, `apps/web`
- Plan step: harness calendar for schedule wakes, visual language from syntet.ru publication calendar
- Commits: this commit
- PR: (open)

## What and why

The scheduler already stored jobs and woke chats, but there was no place to see them. The month grid follows the syntet.ru publication calendar (Monday-first, day cells, a slot with time and title) and uses harness colors so the same grid works on the light theme. «Набор» was a top-level page; it is the component gallery, so it lives under Settings as UI Kit.

## Files touched

- `plugins/scheduler/src/cron.ts`: `cronBetween`
- `plugins/scheduler/src/index.ts`: `GET /p/scheduler/occurrences?from=&to=`
- `apps/web/src/calendar.tsx`, `style.css`, `route.ts`, `app.tsx`
- `apps/web/src/kit.tsx`, `pages.tsx`: heading UI Kit, rendered when the settings section is `uikit`

## Design decisions

- The UI does not reimplement cron. It asks the plugin for occurrences in the visible month. Each job is capped at 48 hits so `* * * * *` cannot fill the grid.
- Light and dark share one layout. Dark cells follow syntet.ru (`#0c0c0e` / `#27272a`, today in acid green). Light cells are white with the same green today border.
- `#/kit` redirects to `#/settings/uikit`.

## Rejected alternatives

- Drawing only `nextRunAt`. A weekly cron would show one day, not the month.
- Leaving «Набор» in the main nav next to Канбан and Календарь.

## Known limitations

- The grid does not open the job or the chat. Cancel still goes through `schedule.cancel`.
- A past `at` still fires on the next tick after process start. That is existing scheduler behavior, not the calendar.

## How to test

Enable `scheduler`, open Календарь, switch the month. `schedule.create` with `at` or cron shows a slot after the tool is approved. Ctrl+F5 after a UI install.
