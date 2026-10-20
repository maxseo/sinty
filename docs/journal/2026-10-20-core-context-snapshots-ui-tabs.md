# Core: context snapshots (`context.inspect`) and plugin Web UI tabs (`ui.tabs`)

- Date: 2026-10-20
- Area: packages/sdk, packages/core (agent, memory-router, host, api, inspect), schemas, apps/web
- Plan step: context-inspector, approved by Max after the design-only review
- Commits: `feat(core): context snapshots for inspector plugins and plugin UI tabs`

## What and why

Max asked to see what goes into the system prompt and how each memory part is formed. Before this change that was
only partly possible: `model.request` journals a hash of the messages, and `memory.recalled` journals recall records.
Nobody could see the assembled prompt, which part came from where, what processors and context plugins changed, or
how many tokens each part took.

Following the "everything as plugins, minimal core hooks" principle, the core gets two generic, opt-in mechanisms. The
inspector itself is a plugin (see `2026-10-20-plugin-context-inspector.md`).

1. **Context snapshots.**
   - `Agent.callModel` calls `PluginHost.inspectors()`. When some plugin may inspect, it creates a `ContextTrace`
     and passes it to `buildContext`.
   - `buildContext` labels the messages it builds (`traceBase`): system, skills, memory blocks, dialogue. It times
     and diffs each context contributor (`traceContributor`).
   - `MemoryRouter.contextMessages(ctx, turn, overrides, trace?)` fills `trace.memory`:
     - facts behind `memory.profile` (`store.profile` + `store.recentLog(10)`, the same calls `block()` makes);
     - the summary;
     - recall: from `runPlan` on the first step, or from the journaled `memory.recalled` on later steps;
     - hook traces for `onTurnStart`, `afterRecall` and `beforeContext` (ms, ok, changed, ids before/after);
     - the final block list.
   - After `stepId` is assigned, `buildSnapshot` turns the trace and the final message list into a
     `ContextSnapshot`:
     - parts with token estimates;
     - tools;
     - totals and totals by kind;
     - redaction (`SecretStore.redact` plus patterns, applied to every string, with the count);
     - inline image data replaced by its size.

     The snapshot goes to each inspector as an IPC message `{ t: "context.snapshot" }`. Delivery is fire-and-forget,
     inside try/catch, so it never fails a turn.
   - Gate (`PluginProcess.inspector`): all of the following must hold:
     - the manifest has `permissions.context: ["inspect"]`;
     - config `plugins.inspect` lists the plugin (human-owned config.yaml, default empty);
     - the plugin registered `ctx.onContextSnapshot`;
     - the plugin is not disabled.
2. **Plugin UI tabs.**
   - Manifest `ui.tabs: [{ id, title, path }]`, validated by zod and the JSON schema:
     - `id` pattern;
     - title length 1–40;
     - path is `/…` with no query, `.`/`..` segments or full URL;
     - at most 8 tabs, unique ids;
     - `ui` needs `static`, `tabs` or both.
   - `GET /v1/plugins` returns `tabs` (`src = /p/<plugin><path>`) and `inspector`.
   - `apps/web` adds the tabs to the nav (`#/t/<plugin>/<tab>`) and renders `PluginTab`: a sandboxed iframe plus the
     `tab/1` postMessage bridge.

## Files touched

- `packages/sdk/src/inspect.ts` (new): `ContextSnapshot`, `ContextPart`, `ContextPartKind`, `ContextHookTrace`,
  `ContextPluginTrace`.
- `packages/sdk/src/plugin.ts`: `PluginPermissions.context`, `UiTab`, `PluginManifest.ui.{static?, tabs?}`,
  `PluginContext.onContextSnapshot`.
- `packages/sdk/src/index.ts`: export.
- `packages/core/src/inspect.ts` (new): trace types, `newTrace`, `traceBase`, `traceContributor`, `diffMessages`,
  `buildSnapshot`, `redactPatterns`, `redactDeep`, `inspectStats`.
- `packages/core/src/agent.ts`: trace in `callModel`/`buildContext`/`memoryPreface`; `sendSnapshot`.
- `packages/core/src/memory-router.ts`: optional `trace` through `contextMessages` → `recallForTurn` → `plan` /
  `runPlan`; no behaviour change without it.
- `packages/core/src/host/host.ts`: `inspects`, `inspector`, `sendSnapshot`, `PluginHost.inspectors()`, start-up
  warnings, `ui.static` check.
- `packages/core/src/host/runner.ts`: `ctx.onContextSnapshot`, `ready.inspects`, `context.snapshot` dispatch.
- `packages/core/src/host/protocol.ts`, `packages/core/src/host/manifest.ts`, `schemas/plugin-manifest.schema.json`.
- `packages/core/src/config.ts`: `plugins.inspect` (optional).
- `packages/core/src/api/server.ts`: `tabs`, `inspector` in `/v1/plugins`; `uiRoot` needs `ui.static`.
- `packages/core/src/index.ts`: exports.
- `apps/web/src/plugin-tab.tsx` (new), `apps/web/src/app.tsx`, `apps/web/src/route.ts`, `apps/web/src/style.css`.
- Tests:
  - `packages/core/src/__tests__/context-inspect.test.ts` (5 tests);
  - fixtures `test-fixtures/plugins/inspect-test`, which records snapshots and optionally adds a context message
    and a `beforeContext` block, and `inspect-noperm`.
- Docs: `docs/spec/context-inspect.md` (new), `docs/spec/plugin-manifest.md`, `docs/architecture.md`, CHANGELOG.

## Design decisions

- **Push, not pull.** The core pushes snapshots and does not store them. The core keeps no new state and no new
  table. Retention and presentation belong to the plugin.
- **Two keys to enable.** The manifest permission alone is not enough: an agent-patched or third-party plugin
  could request it. The human must also name the plugin in `config.yaml`. Removing it from `plugins.inspect` turns
  snapshots off without uninstalling anything.
- **Zero cost when off.** The trace object is created only when `inspectors()` is not empty, and every collector is
  behind `if (trace)`. Tests check `inspectStats.built` to prove no snapshot is built without an inspector.
- **The snapshot after the step id, before the provider call.** That way `snapshot.stepId` equals
  `model.request.stepId`, and the messages are byte-for-byte what the provider gets: the test deep-compares them with
  the recording provider. Fallback routes reuse the same messages, so one snapshot per step is right.
- **Labels by whole-message JSON.** Contributors return new arrays over IPC, so object identity is lost. Labels
  are matched by JSON, each base label is used once, and an unmatched message is attributed to the last contributor
  that added it.
- **Memory blocks.** A block that a `beforeContext` processor rewrote gets `source` = that plugin. Such blocks, and
  the processor's own new blocks, are labelled `processor`.
- **Redaction in the core, before IPC.** The plugin never sees known secret values, even if it has bugs. Patterns are
  conservative, and the count is reported.
- **Recall on later steps.** Recall runs once per turn and its blocks are cached. To still show the records, the trace
  reads the journaled `memory.recalled` event, and only when tracing.
- **Tabs in an opaque-origin iframe.** The UI keeps the API token in localStorage, so tab code must never run in the
  UI's origin. `sandbox="allow-scripts"` without `allow-same-origin` gives an opaque origin. Plugins must serve the
  tab page from a public route and data from token routes. The bridge restricts tabs to their own plugin's GET routes.
  This lets any plugin ship a UI without being trusted with the API.
- **`src` instead of `srcdoc`.** A `srcdoc` document would inherit the UI's CSP (`script-src 'self'`) and could not
  run inline code. A real URL lets the plugin send its own strict CSP, here `connect-src 'none'`.

## Rejected alternatives

- **Journaling full prompts as events.** That would put large, private data into `journal.db` for every step,
  forever, and every `sessions.read` plugin and API client would see it.
- **A context-inspector page inside apps/web, reading a core endpoint.** That needs core API surface and core UI
  code for something that should be optional.
- **Exposing snapshots as a normal `event` subscription.** Event delivery is for journaled events, and any
  `"*"` subscriber would receive them. A dedicated message lets the permission check live in one place.
- **Diffs by LCS per character.** That is expensive and rarely needed. Whole-message add/remove is enough to see what a
  contributor did.

## Migration notes

None. All fields are optional, and existing manifests, plugins and configs behave the same. Restart after editing
`plugins.inspect`.

## Known limitations

- Token counts are estimates (JSON length / 4), not provider tokenizer counts. The real input tokens are in
  `usage.recorded`.
- A contributor that edits a message in place shows up as one removal plus one addition.
- Redaction is pattern-based, best effort.
- No tab-specific permission or allow-list per plugin yet: any running plugin's `ui.tabs` are shown. Tabs are
  sandboxed and see only their own plugin's data.
- `onCompaction` and the summary call are not traced as hooks yet; the snapshot shows the stored summary.

## How to test

- `node --test packages/core/dist/__tests__/context-inspect.test.js`.
- Manually: enable `context-inspector` with `plugins.inspect: [context-inspector]`, send a message, then open
  **Контекст** in the Web UI.
