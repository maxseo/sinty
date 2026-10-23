# Background UX: live status, session trust, stacked approvals

- Date: 2026-10-23
- Area: packages/core (policy trust), packages/sdk (events), apps/web (chat), plugins/responsive-turn, skills/background-tasks
- Plan step: responsive turns UX follow-up (Тест 6)
- Commits: this commit
- PR: (open)

## Why

Тест 6 dumped ~170 `task.progress` notes into the chat wall; every `web.*` still needed a separate approval click; and the model backgrounded research even when the human never asked for background. Max wanted: one live status line in chat (journal keeps the rest), «разрешить всё / больше не спрашивать в этом чате» plus trust phrases in text, stacked approval cards, and a clear rule for when `background: true` is allowed.

## What changed

- Chat no longer appends each `task.progress` / `task.completed` as a timeline note; one live «Фон · …» line updates in place (shimmer). Journal tab still lists raw events.
- Session-scoped `policyTrust` on session metadata + journaled `session.policy_grant`. While set, policy `ask` is skipped (`tool.call.approved` with note `session trust`); `deny` and forced approvals (e.g. `plugin.apply_patch` permission changes) still ask.
- Trust sources: `POST /v1/sessions/:id/policy-grants`, approval `remember: true`, UI «Больше не спрашивать в этом чате», and RU/EN phrases in the user message (`не спрашивай`, `разрешаю всё`, `just do it`, …). Children inherit the parent chat’s grant.
- Approval cards for background children stack with a slight offset; batch «Одобрить все» kept.
- `agent.task` tool description + `responsive-turn` prompt: default wait in-turn; `background: true` only when the human asked for parallel work or for long research while they keep chatting. Skill `skills/background-tasks/SKILL.md` documents the same.

## Alternatives considered

- Put routing rules only in repo-root `AGENTS.md` — rejected (that file is for coding agents on the Sinty repo, not the chat agent).
- Soften progress into fewer notes instead of one live line — still noisy; live line matches Cursor/Grok-style status.
- Per-tool allow patterns instead of full session trust — deferred; Max asked for chat-wide «не спрашивай».

## Migration notes

- After merge: rebuild `packages/sdk` + `packages/core` (`tsc`) **before** `stage.mjs` (stage only copies `dist`). Rebuild `apps/web` into `plugins/ui-web/public`, then stage + install.
- Copy `skills/background-tasks/` into `$SINTY_HOME/skills/` if you want it in the catalog (prompt rule from `responsive-turn` applies without that).

## Known limitations

- Live status shows tool name/phase, not URL/query from args.
- Stacked cards: top card is primary; peeking/expanding the stack is minimal.
- Trust is per session (and its children), not global across chats.
