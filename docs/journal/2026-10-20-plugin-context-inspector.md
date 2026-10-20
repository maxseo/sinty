# Plugin `context-inspector`

- Date: 2026-10-20
- Area: plugins/context-inspector, registry
- Plan step: context-inspector, MVP: snapshot + tab with parts, tokens, per-step history
- Commits: `feat(plugins): context-inspector tab`

## What and why

This plugin is the user-facing part of the context inspection feature. It receives a `ContextSnapshot` for every model
step, keeps the newest ones in memory, and serves a Web UI tab, **Контекст**, that shows:
- the step history, grouped by turn, with total tokens and the change from the previous step;
- cards with the totals;
- a stacked token bar by part kind;
- the ordered list of messages sent to the model, each with kind, source and block id, role, start of the text and
  tokens; clicking a row opens the full text;
- the facts in `memory.profile` (tier/scope/source/date);
- the conversation summary;
- automatic recall (queries, records, whether reused from the first step);
- memory processor hooks (what changed, ms, failures);
- plugin context contributors (added/removed messages, tokens before/after);
- the tool schemas with token estimates.

## Files touched

- `plugins/context-inspector/sinty.plugin.json`:
  - `kinds: ["ui"]`, entry `dist/index.js`;
  - `permissions: { context: ["inspect"] }`;
  - config `keep: 100`, `maxMb: 64`;
  - `ui.tabs: [{ id: "context", title: "Контекст", path: "/tab" }]`;
  - `editable: false`.
- `src/store.ts`: `SnapshotStore`, a ring buffer capped by count and serialized bytes (a single snapshot larger than
  the cap is skipped; a re-sent id replaces the old one), `sessions()`, `list(session)`, `summarize()`.
- `src/page.ts`: `TAB_HTML`, one static page in vanilla JS rendered with `textContent` only, and `TAB_CSP`.
- `src/index.ts`: handler and routes.
  - Public `GET /tab` serves the page with its CSP.
  - Routes that need the token:
    - `GET /sessions`;
    - `GET /snapshots?session=`;
    - `GET /snapshots/:id`;
    - `GET /summary/:id`.
- `src/store.test.ts`: 6 unit tests (`pnpm test` in the package).
- `README.md`.
- `registry/plugins.json`, `plugins/README.md`.

## Design decisions

- **Memory only.** A snapshot is the whole prompt. Persisting it would create a second, unmanaged copy of private
  memory on disk. A restart clears the inspector.
- **List routes return summaries.** Only `/snapshots/:id` returns prompt text. The page polls the list every 3 s
  while visible and the "обновлять" box is on, and follows the newest step unless the user picked an older one.
- **No network for the page.** `connect-src 'none'`; data comes only through the `tab/1` bridge. The page waits for the
  UI's `init` (theme) before its first request.
- **The UI is in Russian**, like the rest of `apps/web`.

## Rejected alternatives

- **A React/Preact bundle for the tab.** It would need a build step and an asset route. The page is small enough as
  one inline document.
- **Server-sent updates to the tab.** The bridge is request/response. Polling summaries is cheap and needs no
  streaming support in the bridge.

## Known limitations / follow-ups

- No search or filter inside a step, and no side-by-side diff of two steps beyond the token delta.
- History is per process and capped (`keep`, `maxMb`).
- No export (JSON download) of a snapshot yet.
- Hook timings for `onCompaction` and `afterTurn` are not shown: the first is not traced, the second runs after the
  turn.

## How to test

- `pnpm --filter @sinty/plugin-context-inspector test`.
- Core: `packages/core/src/__tests__/context-inspector-plugin.test.ts` boots the bundled plugin, checks `/v1/plugins` tabs, the public page and its CSP, the token on data routes, and that the stored snapshot equals the provider request.
- Screenshot from a headless run with a fake model: `/workspace/context-inspector.png` (not committed).
