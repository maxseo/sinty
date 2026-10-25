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
- [2026-10-23-child-tools-wire-and-bg-progress.md](2026-10-23-child-tools-wire-and-bg-progress.md) — wire tool names in agent.task + parent task.progress
| 2026-10-23 | [Bubble child approvals into the parent chat](2026-10-23-bubble-child-approvals.md) | (open) | Parent chat shows agent.task approval cards; pending links to parent. |
| 2026-10-23 | [Background UX: live status, session trust, stacked approvals](2026-10-23-bg-ux-status-grants.md) | (open) | Live Фон line; policyTrust; stacked cards; background opt-in. |
| 2026-10-25 | [MCP skill + agent bind (phase 3)](2026-10-25-mcp-skill-agent-bind.md) | (open) | Skill mcp-install; mcp.install bind=agent|shared so tools work without MCP tab. |
