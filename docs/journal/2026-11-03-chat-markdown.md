# Agent replies render as Markdown

- Date: 2026-11-03
- Area: apps/web
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

The chat showed the model's Markdown source, so a table or a list was a block of pipes and dashes. The bubble now draws headings, lists, tables, links and code. A link is opened only when it is `http`, `https` or `mailto`. Raw HTML stays text.

## Files touched

- `apps/web/src/md.ts`
- `apps/web/src/markdown.tsx`
- `apps/web/src/chat.tsx`
- `apps/web/src/style.css`
