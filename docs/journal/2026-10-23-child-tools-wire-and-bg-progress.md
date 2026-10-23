# Child tool wire names and background task progress

- Date: 2026-10-23
- Area: packages/core (agent.task), packages/sdk (events), apps/web (chat)
- Plan step: responsive turns follow-up (Тест 4)
- Commits: this commit
- PR: (open)

## Why

In Тест 4 a background research child finished «без интернета»: every `web.search` /
`web.read` was `tool.call.denied` with note `not in this child turn's tool list`, never
`approval_requested`. The parent model had passed `tools: ["web__search", …]` (wire form —
what schemas show). Those strings were stored in child `metadata.tools` as-is, while
`processCall` compared them to canonical `web.search`. Schemas were still offered (because
`callModel` maps the allow-list through `toWire`), so the child confidently called web and
was denied every time. Approvals only appeared later when the parent itself called web after
`task.completed`.

Separately, while that child ran (~54s), the parent chat showed nothing after the ACK:
background children do not write into the parent journal until `task.completed`, so the UI
looked idle.

## What changed

- Normalize `agent.task` tool lists with `fromWire` when storing and when reading
  `allowedTools`, so wire (`web__search`) and canonical (`web.search`) both work.
- New journal event `task.progress` on the **parent**: mirrors child
  `tool.started` / `completed` / `denied` / `failed` / `approval_requested` while a
  background task runs. Not added to the model dialogue (`eventsToMessages`), only UI/journal.
- Web chat renders `task.progress` and `task.completed` as short notes («Фон · …»).

## Alternatives considered

- Only fix the allow-list compare (accept either form) without rewriting metadata — weaker
  for old sessions and for anything that reads `metadata.tools` as canonical.
- Mirror full child tool cards into the parent — noisier and duplicates approval UX already
  covered by `childPending` (#22). Thin `task.progress` notes are enough to show “something
  is working”.

## Still missing

- Throttle / coalesce bursts of progress when a child fires many tools in one step.
- Optional: show a single sticky “background task running” card instead of one note per tool.
