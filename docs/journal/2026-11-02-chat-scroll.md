# The chat column does not scroll sideways

- Date: 2026-11-02
- Area: apps/web
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

With «Видео» open the chat is a 20vw column. `.log` set `overflow-y: auto`, and CSS turns the other axis into `auto` as well, so a line a few pixels wider than the column draws a horizontal bar above the composer. Long tokens (paths, code) were also able to set the column's minimum width. The log now clips the horizontal axis, messages wrap anywhere, and the header tabs wrap inside the column instead of sticking out of it.

## Files touched

- `apps/web/src/style.css`

## Design decisions

Clip the log on x and wrap the text. Hiding the bar without wrapping would cut off the end of a long line. The 280px minimum on a tool card stays in the wide chat and drops only in the studio column, where 20vw is often narrower than 280px.

## Rejected alternatives

Leaving `overflow-x: auto` so a wide code line can be scrolled. The column is the chat, and the request was that this bar not be there.

## Migration notes

Hard-refresh the harness (Ctrl+F5). The chat stylesheet is a hashed file; `index.html` is not cached for long.

## Known limitations

A markdown table in a message wraps in the middle of a row when the column is narrower than the row. The words stay visible.

## How to test

Open a chat, press «Видео», and read a long message. The log scrolls down only. The header tabs stay inside the column.
