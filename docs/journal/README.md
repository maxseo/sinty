# Change journal

This folder records **why** the code changed, not only what changed. It is written to be fed to
bots and LLMs (and humans) that need the reasoning behind the current design before they touch it.
Git history says *what*; these entries say *why*, *what else was considered* and *what is still missing*.

## How to use it

- Read the entries for the area you are about to change, newest last. Each entry is self-contained.
- When a design decision here is reversed, write a new entry that links the old one; do not rewrite history.
- Keep `CHANGELOG.md` (user-facing, Keep a Changelog) and this journal (engineering reasoning) in sync:
  every entry ends up as one or more CHANGELOG lines.

## File naming

`YYYY-MM-DD-<area>-<short-slug>.md`, for example `2026-10-19-memory-step-0-cleanup.md`.
Several entries per day are fine; the slug orders them.

## Entry format

Every entry uses the same headings so a model can find sections by name:

```markdown
# <Title>

- Date: YYYY-MM-DD
- Area: <package / subsystem>
- Plan step: <reference to the plan, if any>
- Commits: <short hashes; "this commit" only until the hashes are known>
- PR: <#number> (merge <short hash>), once merged

## What and why
## Files touched
## Design decisions
## Rejected alternatives
## Migration notes
## Known limitations
## How to test
```

Write plain, specific sentences. Name files, functions, config keys and event types exactly as they appear in
code. State limitations honestly; an entry that hides a gap is worse than no entry.

## Index

Date order; entries of one day follow the order their PRs were merged. Every merged PR #1–#18 has at least one entry
and a `CHANGELOG.md` line. Project-level overview: [plan](../plan.md), [roadmap](../roadmap.md), [backlog](../backlog.md).

| Date | Entry | PR | In one line |
|---|---|---|---|
| 2026-10-30 | [Film preview](2026-10-30-film-preview.md) | (open) | The preview shows the clip, and dragging one layer leaves the others where they are. |
| 2026-10-30 | [Film insert](2026-10-30-film-insert.md) | (open) | A file dropped on the timeline stays there. The film now has a source stamp, and the canvas edit is not thrown away. |
| 2026-10-30 | [Film panels](2026-10-30-film-panels.md) | (open) | A film inside a project shows Assets and the timeline. A saved hide-panels value does not blank the canvas. |
| 2026-10-30 | [Film renders](2026-10-30-film-render.md) | (open) | A new film mounts. Composition tags compile as components, not as HTML. |
| 2026-10-30 | [Film opens](2026-10-30-film-black.md) | (open) | A new film paints the editor. Its reply is not taken by another open copy. |
| 2026-10-30 | [Film media](2026-10-30-film-media.md) | (open) | A film opens, and Import media copies the file into that film. |
| 2026-10-30 | [Shell path grant](2026-10-30-shell-path-grant.md) | (open) | A command outside the project asks for those folders only, and a timeout kills the cage. |
| 2026-10-30 | [Program buttons](2026-10-30-program-buttons.md) | (open) | Each missing program has Установить. The download keeps going after the tab request returns. |
| 2026-10-30 | [Films in the project](2026-10-30-project-films.md) | (open) | Each harness project has a video tab. Their project dashboard is not shown. |
| 2026-10-30 | [Diffusion tab visible](2026-10-30-diffusion-tab-visible.md) | (open) | The Diffusion tab paints the editor. The frame no longer stays white. |
| 2026-10-30 | [Editor in the harness](2026-10-30-editor-in-harness.md) | (open) | The Diffusion tab is the editor. Cloud calls are local adapters. |
| 2026-10-30 | [Program install](2026-10-30-program-install.md) | (open) | Programs download into Sinty\tools. Diffusion's tab opens the editor window. |
| 2026-10-29 | [Program lookup](2026-10-29-runtime-lookup.md) | (open) | Programs are found on disk. Diffusion's tab downloads the Windows installer. |
| 2026-10-29 | [Diffusion Studio](2026-10-29-diffusion.md) | (open) | Agents open a Diffusion Studio project and call its CLI. Generate asks first. |
| 2026-10-29 | [Runtimes installer](2026-10-29-runtimes.md) | (open) | One plugin installs FFmpeg, Python and ImageMagick. Render uses the Playwright Chromium. |
| 2026-10-29 | [HyperFrames plugin](2026-10-29-hyperframes-plugin.md) | (open) | Agents write and render a HyperFrames composition. The tab shows upstream updates. |
| 2026-10-29 | [Site plugin paused](2026-10-29-site-plugin-paused.md) | (open) | Site plugin status is written in the roadmap. Work on it is paused. |
| 2026-10-29 | [Constructor canvas](2026-10-29-site-builder-canvas.md) | (open) | The constructor tab is a dark canvas with block frames and a properties panel. |
| 2026-10-29 | [Pages and the constructor pick](2026-10-29-site-pages-fields.md) | (open) | Pages are internal records with meta fields. The constructor chooses the front page, one page, or a category. |
| 2026-10-29 | [Front page without an address](2026-10-29-site-home.md) | (open) | Home is a list choice. It opens at the site root. The pages form shows why a save failed. |
| 2026-10-29 | [Pages and blog tabs](2026-10-29-site-pages-blog.md) | (open) | A person creates pages, categories and posts. Home is the page slug home. A template is a shared block. |
| 2026-10-29 | [Human constructor](2026-10-29-site-human-builder.md) | (open) | Constructor tab creates and publishes pages. Tab bridge can POST to the plugin. |
| 2026-10-29 | [Site chat](2026-10-29-site-chat.md) | (open) | Visitor chat at /p/site/chat. One harness session per browser. |
| 2026-10-29 | [Site form](2026-10-29-site-forms.md) | (open) | Form widget stores the client's email and Telegram. The agent sends through a harness connector. |
| 2026-10-29 | [Visitor login](2026-10-29-site-visitors.md) | (open) | Visitor email accounts in the site DB, cookie session, closed pages open after login. |
| 2026-10-29 | [Site constructor](2026-10-29-site-constructor.md) | (open) | Widget tree on site records, template as a dynamic block, Конструктор tab. |
| 2026-10-29 | [Site plugin, first slice](2026-10-29-site-plugin.md) | (open) | SQLite records for pages, posts, categories and templates; agent tools and two harness tabs. |
| 2026-10-29 | [Agent-made plugins](2026-10-29-agent-made-plugins.md) | (open) | `plugin.create`: the agent writes a new plugin under narrower rules; a human approves its first start. |
| 2026-10-29 | [Plugin rights](2026-10-29-plugin-rights.md) | (open) | Every plugin tab and settings section is a row in Права, closed by default for new ones; core settings split. |
| 2026-10-28 | [Staff access fix](2026-10-28-staff-access-fix.md) | (open) | Admins run staff without superadmin powers; hidden sections; rotate, plugin, settings and stream routes check roles. |
| 2026-10-28 | [Staff accounts](2026-10-28-staff-accounts.md) | (open) | Superadmin, roles, per-project grants, reset link. Machine token unchanged. |
| 2026-10-27 | [Turn generation on Stop](2026-10-27-turn-generation.md) | (open) | A tool result after Stop is `stale_turn`, without its payload. |
| 2026-10-27 | [One send, one turn](2026-10-27-send-once.md) | (open) | Composer reuses one idempotency key and ignores a second click. |
| 2026-10-27 | [One-shot delay in seconds](2026-10-27-scheduler-delay-seconds.md) | (open) | `delaySeconds` wakes this chat; cron stays the repeat. Policy allows the tool. |
| 2026-10-26 | [Scheduler month calendar and UI Kit in Settings](2026-10-26-scheduler-calendar.md) | (open) | Month grid from cron expansion. «Набор» moved to Settings → UI Kit. |
| 2026-10-26 | [Kanban rebuilt around a project team](2026-10-26-kanban-team-board.md) | (open) | Assignee, reviewer, dependencies, team-chat notes. No accept column or dispatcher. |
| 2026-10-26 | [Stop stays available while a child is blocked](2026-10-26-stop-while-blocked.md) | (open) | «Стоп всё» while a child runs or waits; × on «Ждут ответа» interrupts that turn only. |
| 2026-10-26 | [Settings → Лимиты and a higher plugin day budget](2026-10-26-limits-section.md) | (open) | `pluginTokensPerDay` default 2_000_000; four core caps editable without a restart. |
| 2026-10-26 | [A stalled background child tells the parent](2026-10-26-background-stall-notify.md) | (open) | Supervisor or budget block wakes the parent once and the «Фон» line says it stopped. |
| 2026-10-26 | [Background by size, not by an explicit request](2026-10-26-background-by-size.md) | (open) | Long or parallel `agent.task` goes to the background without the human asking. Revert note in the entry. |
| 2026-10-26 | [vision.look batches](2026-10-26-vision-batch.md) | (open) | `paths` plus Settings Batch, default 4 images per model request. |
| 2026-10-26 | [vision.look: no output cap, reasoning off by default](2026-10-26-vision-no-token-cap.md) | (open) | Side call omits `max_tokens`; DeepSeek thinking disabled unless the Vision switch is on. |
| 2026-10-26 | [tool-vision: look at workspace images](2026-10-26-tool-vision.md) | (open) | `vision.look` side vision call for repo images; skill `vision-look`. |
| 2026-10-19 | [Memory step 0: retire `plugins/memory`, reserve core tool names, fix scopes, one connection](2026-10-19-memory-step-0-cleanup.md) | [#1](https://github.com/maxseo/sinty/pull/1) | Golden prompt baseline and hygiene before the memory contract. |
| 2026-10-19 | [Memory step 1: the memory contract](2026-10-19-memory-step-1-contract.md) | [#1](https://github.com/maxseo/sinty/pull/1) | `docs/spec/memory.md` and SDK types for providers, processors and `ctx.models`. |
| 2026-10-19 | [Memory step 2: builtin:sqlite and MemoryRouter](2026-10-19-memory-step-2-router.md) | [#1](https://github.com/maxseo/sinty/pull/1) | Memory logic moves out of `Agent` behind one router, behaviour 1:1. |
| 2026-10-19 | [Memory step 3: models through the core](2026-10-19-memory-step-3-models-gateway.md) | [#1](https://github.com/maxseo/sinty/pull/1) | `ModelGateway`, `ctx.models.complete/embed`, routes and plugin budgets. |
| 2026-10-19 | [Memory step 4: plugin providers and processors over IPC](2026-10-19-memory-step-4-plugins-ipc.md) | [#1](https://github.com/maxseo/sinty/pull/1) | Hooks, timeouts, fallback, recall budget, durable `afterTurn` queue. |
| 2026-10-19 | [Memory step 5: memory-obsidian, fact-extractor, vector search](2026-10-19-memory-step-5-plugins-vectors.md) | [#1](https://github.com/maxseo/sinty/pull/1) | Builtin vectors when an embed route is set; first memory plugins. |
| 2026-10-19 | [Memory step 6: experiments and `sinty memory eval`](2026-10-19-memory-step-6-experiments-eval.md) | [#1](https://github.com/maxseo/sinty/pull/1) | Weighted arms, shadow mode, offline eval from the journal. |
| 2026-10-20 | [Drain the afterTurn memory queue before shutdown](2026-10-20-fix-run-drain-memory-queue.md) | [#2](https://github.com/maxseo/sinty/pull/2) | `Sinty.stop()` waits for this process's memory jobs. |
| 2026-10-20 | [Windows test run of PR #1 + #2 and two Windows fixes](2026-10-20-core-windows-test-run.md) | [#3](https://github.com/maxseo/sinty/pull/3) | Golden path normalisation and ShellBox lookup; a test report, not a feature. |
| 2026-10-20 | [Recall: AND → OR → prefix fallback](2026-10-20-memory-recall-or-prefix-fallback.md) | [#3](https://github.com/maxseo/sinty/pull/3) | Full-text recall no longer needs every word to match. |
| 2026-10-20 | [`sinty memory reindex`](2026-10-20-memory-reindex-vectors.md) | [#3](https://github.com/maxseo/sinty/pull/3) | Backfill vectors for facts written before the embed route. |
| 2026-10-20 | [memory.write through the tool emits memory.written](2026-10-20-memory-tool-writes-journaled.md) | [#3](https://github.com/maxseo/sinty/pull/3) | Tool writes are journaled like automatic ones. |
| 2026-10-20 | [Plugin token budget survives restarts](2026-10-20-models-persistent-plugin-budget.md) | [#3](https://github.com/maxseo/sinty/pull/3) | Per-UTC-day plugin usage kept in `journal.db`. |
| 2026-10-20 | [Context snapshots and plugin UI tabs](2026-10-20-core-context-snapshots-ui-tabs.md) | [#4](https://github.com/maxseo/sinty/pull/4) | `context.inspect` snapshots for plugins; `ui.tabs` in manifests. |
| 2026-10-20 | [Plugin `context-inspector`](2026-10-20-plugin-context-inspector.md) | [#4](https://github.com/maxseo/sinty/pull/4) | Tab with prompt parts, tokens and per-step history. |
| 2026-10-20 | [Session tabs: Контекст in the chat header](2026-10-20-ui-session-tabs-context-in-chat-header.md) | [#4](https://github.com/maxseo/sinty/pull/4) | Inspector moves into the chat header. |
| 2026-10-20 | [Merging PR #3 and PR #4](2026-10-20-merge-memory-limitations-and-context-inspector.md) | [#4](https://github.com/maxseo/sinty/pull/4) | How the two branches were merged and re-tested. |
| 2026-10-20 | [Chat agent selection](2026-10-20-fix-chat-agent-selection.md) | [#5](https://github.com/maxseo/sinty/pull/5) | The chat's own agents decide who speaks (prompt-cache report, part 1). |
| 2026-10-20 | [Cache-friendly prompt](2026-10-20-core-cache-friendly-prompt.md) | [#6](https://github.com/maxseo/sinty/pull/6) | Append-only requests, frozen turn context, provider cache hints (report, part 2). |
| 2026-10-20 | [Supervisor settings UI](2026-10-20-supervisor-settings-ui.md) | [#7](https://github.com/maxseo/sinty/pull/7) | Configurable limits, chat-header tab, masked incidents. |
| 2026-10-21 | [Web tools move into `tool-web`](2026-10-21-tool-web-plugin.md) | [#8](https://github.com/maxseo/sinty/pull/8) | Plan step 7 part 1; SSRF guard becomes a core service. |
| 2026-10-21 | [tool-web on agent cards, agent.task tools, one fold per turn](2026-10-21-tool-web-agents-memory-snapshot.md) | [#9](https://github.com/maxseo/sinty/pull/9) | Two regressions found on installed main. |
| 2026-10-21 | [Web errors keep their meaning](2026-10-21-web-errors-supervisor-notices.md) | [#10](https://github.com/maxseo/sinty/pull/10) | Site refusals no longer count as tool misuse. |
| 2026-10-21 | [Skills move into the `skills` plugin](2026-10-21-skills-plugin.md) | [#11](https://github.com/maxseo/sinty/pull/11) | Plan step 7 part 2; `ctx.systemSection` for stable prompt blocks. |
| 2026-10-22 | [Silence the --allow-child-process SecurityWarning](2026-10-22-child-process-warning.md) | [#16](https://github.com/maxseo/sinty/pull/16) | By warning code when Node prints one, per plugin process. |
| 2026-10-22 | [Stemming for memory recall](2026-10-22-memory-stemming.md) | [#13](https://github.com/maxseo/sinty/pull/13) | Russian Snowball and English porter stems in FTS. |
| 2026-10-22 | [Login token rotation](2026-10-22-login-token-rotation.md) | [#15](https://github.com/maxseo/sinty/pull/15) | CLI, Settings button and `POST /v1/auth/rotate`; open streams re-checked. |
| 2026-10-22 | [Context window per model](2026-10-22-context-window.md) | [#14](https://github.com/maxseo/sinty/pull/14) | `memory.contextTokens: auto`, ring in Контекст, compaction cap, fallback window check. |
| 2026-10-22 | [Re-embedding after a model or width change](2026-10-22-reembed.md) | [#12](https://github.com/maxseo/sinty/pull/12) | `facts_vec_meta`, `sinty memory reembed`, `memory.reembed: auto`. |
| 2026-10-22 | [Linux sandbox for shell.run](2026-10-22-linux-shell-sandbox.md) | [#17](https://github.com/maxseo/sinty/pull/17) | bubblewrap, network off by default, `shell.sandbox`. |
| 2026-10-22 | [`sinty doctor` reports the capped compaction point](2026-10-22-doctor-compaction-cap.md) | [#18](https://github.com/maxseo/sinty/pull/18) | The doctor uses the core's compaction rule. |
| 2026-10-22 | [Project state docs for handoff](2026-10-22-docs-project-state.md) | [#19](https://github.com/maxseo/sinty/pull/19) | `docs/plan.md`, roadmap/backlog refresh, journal audit and this index. |
| 2026-10-23 | [Responsive turns (background agent.task, stop-all, steer)](2026-10-23-responsive-turns.md) | (open) | Background children, task.completed, cascade stop, default-on plugin. |
| 2026-10-23 | [Responsive-turn UX: hide children, no restart after stop-all](2026-10-23-responsive-turn-ux.md) | [#21](https://github.com/maxseo/sinty/pull/21) | Sidebar skips child sessions; interrupted tasks do not wake parent. |
- [2026-10-25-mcp-curated-catalog.md](2026-10-25-mcp-curated-catalog.md) — MCP phase 4 curated catalog cards
- [2026-10-23-child-tools-wire-and-bg-progress.md](2026-10-23-child-tools-wire-and-bg-progress.md) — wire tool names in agent.task + parent task.progress
| 2026-10-23 | [Bubble child approvals into the parent chat](2026-10-23-bubble-child-approvals.md) | (open) | Parent chat shows agent.task approval cards; pending links to parent. |
| 2026-10-23 | [Background UX: live status, session trust, stacked approvals](2026-10-23-bg-ux-status-grants.md) | (open) | Live Фон line; policyTrust; stacked cards; background opt-in. |
| 2026-10-25 | [MCP skill + agent bind (phase 3)](2026-10-25-mcp-skill-agent-bind.md) | (open) | Skill mcp-install; mcp.install bind=agent|shared so tools work without MCP tab. |
