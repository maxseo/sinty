# Supervisor: configurable limits, a chat-header tab, settings sections, masked incidents

- Date: 2026-10-20
- Area: packages/supervisor, packages/core (config, agent, journal, API, manifest), packages/sdk, schemas, apps/web, plugins/context-inspector
- Plan step: Max's feedback while testing main df22dbc
- Commits: `feat(supervisor): configurable limits, chat tab, settings sections, masked incidents`

## What and why

Max tested main after the prompt-cache work and reported four things:

1. In the chat **Журнал** tab the orange «Вызов» badge of tool rows was a wide box over the tool name.
2. The supervisor limits were partly hard-coded:
   - `maxNoticesPerDetector: 2` in `sinty.ts`;
   - the 80% warning, "2 failures", "3 turns" and "threshold + 2" in `supervisor.ts`.

   The rest were split between `config.yaml` and `policy.yaml`, none could be edited in the UI, and a long cached turn
   hit the 600k token budget although it had cost little.
3. **Супервизор** and **Журнал** were global pages in the left sidebar. Both belong to a chat, like **Контекст**.
4. The supervisor's incident memory stored raw arguments of the successful call. These included text typed into a
   login form through `web.interact` and whole file contents, and the Супервизор page showed them.

## Files touched

- **Журнал badge:** `apps/web/src/chat.tsx`, `style.css`. The lane classes were `input`, `model` and `tool`, and the
  global `.tool` rule (the tool-call card: min-width 280px, border, padding) applied to `<span class="pill tool">`.
  The lanes are now `lane-input`, `lane-model`, `lane-tool` and `lane-system`, in both the list pills and the timeline
  segments.
- **Supervisor process:**
  - `packages/supervisor/src/protocol.ts`:
    - `SupervisorSettings` gains `loopBlockAfter`, `escalate`, `repeatFailures`, `patchAfterTurns`,
      `useIncidents`, `checks` and `budget.{warnAt,count,cachedWeight}`;
    - `resolveSettings()` holds the defaults;
    - `budgetTokens()` is shared with the core;
    - new message `{ t: "settings" }`.
  - `packages/supervisor/src/supervisor.ts` uses them all and adds `setSettings()`.
  - `packages/supervisor/src/main.ts` handles the new message.
- **Masking:**
  - `packages/supervisor/src/scrub.ts`:
    - `maskArgs()` (structured) and `scrubText()` (text, idempotent);
    - used for incident `fixSummary`, failure messages and quoted incidents.
  - `packages/core/src/sinty.ts`:
    - masks again, plus the secret store's redaction, before `addIncident`;
    - on start runs `journal.scrubIncidents(scrubText)`, which rewrites old rows;
    - adds `supervisorSettings()`, built from config.
  - `packages/core/src/supervisor-client.ts` adds `setSettings()` and keeps the settings for restarts.
- **Config:**
  - `packages/core/src/config.ts`:
    - the full `supervisor` schema (`checks`, `budget`, …);
    - `effectiveBudget()`: `config.yaml` numbers win, unset ones come from `policy.yaml budgets.turn`, 0 = no limit.
  - `packages/core/src/agent.ts`:
    - the turn view counts tokens with `budgetTokens()` in the configured mode;
    - `overBudget()` uses `effectiveBudget()` and returns nothing with `budget.stop: false`;
    - the stall guard does not abort with `stallBlock: false`.
- **Settings sections:**
  - `packages/sdk/src/settings.ts`: `SettingsField`, `SettingsSectionManifest` and `SettingsSection`.
  - `PluginManifest.settings`, with matching changes in `packages/core/src/host/manifest.ts` (strict zod) and
    `schemas/plugin-manifest.schema.json`.
  - `packages/core/src/settings-sections.ts`:
    - the core's `SUPERVISOR_SECTION`;
    - `listSections()`;
    - `saveSection()`: validates every field and writes through `parseDocument().setIn/deleteIn`, so comments survive;
      it restores the file if the config schema rejects the result.
- **API (`packages/core/src/api/server.ts`):**
  - `GET /v1/settings/sections`;
  - `PUT /v1/settings/sections/:id`: the supervisor section applies live (config object plus `setSettings`), plugin
    sections after a restart;
  - `/v1/supervisor?sessionId=`, with masked texts.
- `plugins/context-inspector/sinty.plugin.json` declares a «Контекст» section (`keep`, `maxMb`). This is the first
  plugin using the mechanism.
- **Web UI:**
  - `apps/web/src/supervisor-ui.tsx`: `SupervisorView` (the chat tab), `SectionPane` (a generic form) and
    `useSections()`.
  - `app.tsx`:
    - the sidebar loses **Журнал** and **Супервизор**;
    - a «Ждут ответа» block appears when something waits for a human;
    - section links are added to the settings nav.
  - `route.ts`: `pending` and `supervisor` routes removed (old links open the chat list); a settings section is any
    section id.
  - `chat.tsx`: the **Супервизор** header tab, with a badge counting this chat's notices.
  - `pages.tsx`: `PendingPage` and `SupervisorPage` removed; `SettingsPage` renders `SectionPane` for other ids.
- **Tests:**
  - `packages/supervisor/src/settings.test.ts`;
  - `packages/core/src/__tests__/supervisor-settings.test.ts`;
  - the fake provider takes a per-step `usage`.
- **Docs:** `docs/spec/supervisor.md` (configuration, masking, what a budget token is), `plugin-manifest.md`
  (`settings`) and `protocol.md` (endpoints).

## Design decisions

- **The supervisor stays core.**
  - The supervisor is the protected watcher of the agent, and the agent can patch plugins, so it must not be one.
  - The UI part follows the plugin mechanisms anyway:
    - the chat tab sits with the session tabs;
    - its settings use the same declarative section format a plugin declares in its manifest.
  - Making the tab a plugin iframe would need new core data APIs for incidents just to let a plugin read them. The
    UI is the core's own `ui-web`, so a native tab is the smaller change.
- **One settings mechanism for core and plugins.** A section is a title plus a flat list of typed fields over one
  object in `config.yaml`, with dot-path keys:
  - the core section maps to `supervisor:`;
  - a plugin section maps to `plugins.config.<name>`, with its manifest `config` as the defaults.

  The UI renders every section with one form component. Plugins get this without shipping UI code or an iframe.
- **The budget lives in `config.yaml` and falls back to `policy.yaml`.** `policy.yaml` stays the safety-floor file.
  Existing installs keep their numbers (60 steps, 600k tokens, 1200 s), because unset fields fall back to it.
- **Tokens are counted "weighted" by default.**
  - The cost is `input − cached + output + cached × 0.1`. Anthropic, OpenAI and DeepSeek all bill cache reads at
    about a tenth of the input price, so this tracks the bill without a price table.
  - Counting only uncached tokens would let an expensive "everything cached but huge" turn run forever.
  - Counting everything (the old behaviour) penalises exactly the caching we just built.
  - `uncached` and `all` remain as options.
  - A USD budget is not offered, because providers never fill `costUsd`.
- **Escalation can be turned off without turning checks off.** With `escalate: false`:
  - notices still go to the model up to the limits, and extra ones are dropped;
  - loops never block.

  Each check has its own switch (`checks.*`).
- **Masking happens in four places:**
  - at the source (the supervisor never builds a summary from raw arguments);
  - at store time in the core;
  - on load (old rows);
  - at display (`/v1/supervisor`).

  Journal events are append-only and are not rewritten.

## Rejected alternatives

- Moving the supervisor into a plugin: the agent could patch its own watcher.
- A plugin-specific settings iframe: every plugin would ship a form, and values would not go through `config.yaml`
  validation.
- Rewriting journal events to drop typed text: it breaks the append-only journal and replay.

## Migration notes

- No action needed. Without a `supervisor.budget` block, `policy.yaml` numbers apply as before.
- The token count switches from "all" to "weighted". Turns with heavy cache use stop much later. Set
  `supervisor.budget.count: all` to restore the old behaviour.
- Old incidents are masked at the first start: the log says `supervisor: masked N stored incident(s)`.
- `#/pending` and `#/supervisor` links now open the chat list. Pending items are in the sidebar «Ждут ответа» block,
  and approvals happen in the chat.

## Known limitations

- The removed **Журнал** page let you approve or deny tool calls of several chats from one list. Now you open the
  chat from «Ждут ответа» and answer there. Nothing else was lost: the per-chat Журнал tab has the event log.
- The chat's **Журнал** tab still shows the raw arguments of that chat's own tool calls, including typed text, because
  it reads the journal.
- Plugin sections apply after `sinty web` restarts, since plugins read `ctx.config` at start.
- Toggling `supervisor.enabled` also needs a restart.
- The masking is pattern-based. A secret passed under an innocent key (e.g. `{"q": "…"}` in a search) is only
  shortened, not hidden.

## How to test

- `pnpm -r run test`. The new tests:
  - `packages/supervisor/src/settings.test.ts`: defaults, `budgetTokens`, checks off, `escalate: false`, live
    `setSettings`, typed text never in incidents, `maskArgs`/`scrubText`.
  - `packages/core/src/__tests__/supervisor-settings.test.ts`:
    - `effectiveBudget`;
    - a cached turn finishes with "weighted" and blocks with "all", and «Продолжить» works;
    - `budget.stop: false`;
    - the sections API round-trip keeps YAML comments;
    - old incidents are scrubbed on start;
    - `/v1/supervisor?sessionId=` filtering.
- **Manual:**
  1. Open a chat and check the header tabs: Чат / Журнал / **Супервизор** / Контекст.
  2. Open Settings → **Супервизор**, change «Токенов на ход» and save. `config.yaml` gets `supervisor.budget.tokens`.
