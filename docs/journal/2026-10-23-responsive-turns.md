# Responsive turns: background agent.task, stop-all, steer, pulse

- Date: 2026-10-23
- Area: `packages/core` (agent, stall, coretools, config, api), `packages/sdk` (events), `plugins/responsive-turn`, `apps/web`
- Plan step: harness gaps from harness comparison (user turn loop vs Sinty); plugins over core where possible; supervisor stays in core
- Commits: this commit
- PR: (open)

## What and why

Sinty's chat turn used to block on every `agent.task` child. A long research child made the parent look hung (stall
timer), the Stop button only cancelled the parent, and a second user message while waiting for approval got `409`.
Other harnesses (and Max's product expectation) acknowledge the user first, run long work in the background, and
report when it finishes.

This change adds that loop in the **core** (tools, events, interrupt tree, stall pulse, limits) and a **default-on
plugin** `responsive-turn` that teaches the model the style via `ctx.systemSection`. Behaviour that is only a prompt
rule stays a plugin so it can be disabled without a core release.

## Files touched

- `packages/core/src/stall.ts`: `pulse()` resets the two-step silence window.
- `packages/core/src/agent.ts`: cascade `interrupt` / `stopAll`; background `agent.task` + deferred start;
  `task.completed` + trigger=`task` turn (deferred if parent busy); `agent.task_steer`; stall pulse on blocking
  child progress; approval-wait queues `message.user` (no 409); `ask_human` still resumes the same turn;
  `taskMaxParallel` / `taskTreeTokens`; `task.completed` in dialogue.
- `packages/core/src/coretools.ts`: `background` on `agent.task`; new `agent.task_steer`.
- `packages/core/src/ids.ts`: `tsk` prefix; `packages/sdk/src/events.ts`: `task.completed`.
- `packages/core/src/config.ts`: `agent.taskMaxParallel` (default 3), `agent.taskTreeTokens` (default 0 = off),
  `DEFAULT_ON_PLUGINS` += `responsive-turn`.
- `packages/core/src/api/server.ts`: `POST /v1/sessions/:id/stop-all`.
- `apps/web/src/chat.tsx`: Stop → «Стоп всё» / `stop-all`; refresh on `task.completed`.
- `plugins/responsive-turn/*`: context plugin with the responsive-turn system section.
- Tests: `responsive-turns.test.ts`, stall pulse, approval queue in `agent.test.ts`.

## Design decisions

- **Core owns the protocol; plugin owns the style.** Tools, events, interrupt tree and limits must be correct even
  when the plugin is disabled. The prompt rule is optional and editable.
- **Background child start is deferred one microtask** so the parent finishes the tool step and takes the next model
  call before the child races it (shared fake-provider scripts in tests; fairer scheduling in production).
- **`task.completed` on a busy parent is journaled immediately; a trigger=`task` turn starts when the parent leaves
  `running`** (`pendingTaskTurns` + `launch` finally). Attaching only to an active turn would never open a reporting
  turn after the ack.
- **Stop button calls `stop-all`.** Plain `interrupt` remains for API clients that want parent-only cancel; the UI
  matches the product expectation that Stop ends the whole tree.
- **Approval wait queues into the blocked turn** instead of 409. `ask_human` still completes the pending call and
  resumes the same turn (must not fall through to a new turn).
- **Limits:** `taskMaxParallel` (default 3) counts live + in-flight background starts; `taskTreeTokens` (default 0)
  is opt-in for a parent+children token ceiling.

## Rejected alternatives

- Putting `agent.task` background mode only in a plugin: children, interrupt trees and journal events are core
  concerns; a plugin cannot own them safely.
- CloudAgent overnight implementation: Max preferred the box; Shell Auto-review blocked overnight and was unblocked
  the next morning.
- One shared fake-provider script for parent and child in tests: assistant-count indexing collides across sessions;
  the background test uses `recording-provider` keyed by last user text instead.
- Replacing kanban with a schedule plugin for item 8: different jobs (durable cron vs board); noted in backlog only.

## Migration notes

- New default-on plugin `responsive-turn`. Turn off with `plugins.disabled: [responsive-turn]` or an agent card's
  `excludedPlugins`. Existing installs without that key pick it up via `ensureDefaultOn`.
- New optional config keys under `agent:` with safe defaults. No journal migration.
- Web UI Stop now stops the child tree; clients that relied on parent-only interrupt keep `POST .../interrupt`.

## Known limitations

- `taskTreeTokens` is off by default (0); operators must opt in.
- Background children do not inherit the parent's AbortSignal after the tool returns (by design); use `stop-all` or
  `agent.task_steer` / interrupt on the child.
- The schedule plugin (durable timers/cron) is **not** implemented here; see backlog — it is not kanban.

## How to test

```bash
pnpm --filter @sinty/core run build
node --test --test-concurrency=1 packages/core/dist/__tests__/responsive-turns.test.js \
  packages/core/dist/__tests__/stall.test.js packages/core/dist/__tests__/agent.test.js
pnpm --filter @sinty/plugin-responsive-turn run build
pnpm --filter @sinty/web run build   # writes plugins/ui-web/public
```
