# Session tabs: **Контекст** moves into the chat header

- Date: 2026-10-20
- Area: packages/sdk (UiTab), packages/core (manifest, /v1/plugins), schemas, apps/web (chat header, bridge), plugins/context-inspector
- Plan step: context-inspector follow-up, from Max's feedback on PR #4
- Commits: `feat(ui): session tabs; context-inspector in the chat header`
- PR: [#4](https://github.com/maxseo/sinty/pull/4) (merge `24ba03f`)
- Revises: [`2026-10-20-plugin-context-inspector.md`](2026-10-20-plugin-context-inspector.md) (sidebar page with a session picker) and the `ui.tabs` part of [`2026-10-20-core-context-snapshots-ui-tabs.md`](2026-10-20-core-context-snapshots-ui-tabs.md)

## What and why

The first version of `context-inspector` added **Контекст** to the left sidebar, as a page of its own with a session
picker. Max's feedback: the context belongs to a chat, the same way **Журнал** in the chat header is that chat's event
log. You are in a chat and want to see what that chat sent to the model, not pick it again from a dropdown of ids.

So:
1. `ui.tabs[]` gets an optional `placement`: `"sidebar"` (default, the old behaviour) or `"session"`.
2. The Web UI shows `session` tabs as another view toggle in the open chat's header, after **Чат** and **Журнал**.
   The iframe takes the log's place between the header and the composer, so the user can keep typing while looking at
   the context.
3. The `tab/1` bridge tells a session tab which chat is open: `init.sessionId`, and `{ op: "session", sessionId }`
   when it changes.
4. `context-inspector` declares `placement: "session"`:
   - it drops its session picker and shows only the open chat;
   - it opens the newest step and follows new steps live;
   - it shows a clear empty state when the chat has no snapshots yet.

The core change is one optional enum field in the manifest schema and one field in `/v1/plugins`. Everything else is
in the Web UI and the plugin, in keeping with "everything as plugins, minimal core".

## Files touched

- `packages/sdk/src/plugin.ts`: `UiTab.placement?: UiTabPlacement`, `type UiTabPlacement = "sidebar" | "session"`,
  doc comment on what the bridge sends.
- `packages/core/src/host/manifest.ts`: `uiTabSchema.placement: z.enum(["sidebar", "session"]).optional()`. The
  object stays `.strict()`, so typos fail.
- `schemas/plugin-manifest.schema.json`: same, `enum` with `default: "sidebar"`.
- `packages/core/src/api/server.ts`: `/v1/plugins` `tabs[]` gains `placement`, filled in as `"sidebar"` when the
  manifest omits it, so clients never guess.
- `apps/web/src/plugin-tab.tsx`:
  - `PluginTabInfo.placement`, `tabViewKey()`;
  - `PluginTab` takes an optional `sessionId`, puts it in `init`, and posts `op: "session"` when the prop changes
    after the frame said `ready`;
  - the GET-only, own-routes-only bridge is unchanged.
- `apps/web/src/app.tsx`: splits tabs by placement. Only `sidebar` tabs go to the left nav and the `#/t/…` route
  (a `session` tab's old `#/t/` link now shows "not found"). `session` tabs are passed to `<Chat tabs>`.
- `apps/web/src/chat.tsx`:
  - the header `.tabs` renders a button per session tab after Чат/Журнал;
  - the view state is `"chat" | "journal" | "tab:<plugin>/<id>"`, and a plugin view renders
    `<div class="session-tab"><PluginTab sessionId=…/></div>`;
  - the chosen plugin view is stored in `localStorage["sinty.chatView"]` and restored in the next chat, also when
    `/v1/plugins` answers after the chat mounted;
  - picking Чат/Журнал clears it.
- `apps/web/src/style.css`: `.session-tab` fills the column between header and composer.
- `plugins/context-inspector/sinty.plugin.json`: `placement: "session"`, new description (same text in
  `registry/plugins.json`).
- `plugins/context-inspector/src/page.ts`:
  - the header is now «Контекст чата» with the status («N ход(ов) · M шаг(ов)») and «обновлять»; the `<select id="session">` is gone;
  - `setSession()` resets state on `init`/`session` and bumps an `epoch` counter, so a reply still in flight for the
    previous chat is dropped;
  - polling (3 s) starts only after `init` and asks only `/snapshots?session=<open chat>`;
  - follow logic: follow the newest step unless the user pinned an older one, and re-follow if the pinned step fell
    out of the ring;
  - empty states: «Чат не открыт» and «Для этого чата снимков пока нет — снимки появляются начиная со следующего
    сообщения…» (explains in-memory storage and restarts);
  - a narrow-width layout stacks the step list above the detail.
- `plugins/context-inspector/src/page.test.ts` (new): runs the page's inline script in `node:vm` with a fake DOM and
  a fake parent, as described under How to test.
- `plugins/context-inspector/src/store.test.ts`: the page has no session picker and handles `op: "session"`.
- `packages/core/src/__tests__/context-inspect.test.ts`: placement accepted (`session`, `sidebar`, omitted) and
  rejected (`"header"`, `""`, `1`).
- `packages/core/src/__tests__/context-inspector-plugin.test.ts`: `/v1/plugins` lists `placement: "session"`.
- Docs: `docs/spec/context-inspect.md` (placement table, bridge messages, remembered view, session id note),
  `docs/spec/plugin-manifest.md`, `plugins/context-inspector/README.md`, `CHANGELOG.md`.

## Design decisions

- **A placement enum, not a separate `ui.sessionTabs` list.** It is one field on the existing tab object, it is
  backward compatible (omitted = sidebar), and the same plugin can have both kinds. It also leaves room for later
  values (for example, a right-hand panel) without a new manifest key.
- **The bridge pushes the session; the tab does not ask for it.** A pushed id needs no new request type and keeps
  the bridge GET-only. The id is not a secret and widens nothing: the tab still reaches only its own plugin's routes.
- **Both `init.sessionId` and `op: "session"`.** `Chat` is keyed by session id in `app.tsx`, so today a switch
  remounts it and the frame gets a fresh `init`. Making the tab handle `op: "session"` too means a later UI change can
  keep the frame alive without breaking plugins. The test covers both paths.
- **Remember plugin views across chats, but not Журнал.** Walking through chats with **Контекст** open is the point
  of this view. Persisting Журнал would change existing behaviour nobody asked about.
- **The composer stays visible**, as with Журнал. Writing a message and seeing the new step appear is the main loop.
- **The plugin keeps `/sessions`.** Unused by the tab now, but harmless (token-only) and handy for scripts. Removing
  it is a one-line follow-up if wanted.

## Rejected alternatives

- Keep the sidebar page and pre-select the last open chat: still a second place to look, and the session picker
  would still need ids or titles. The plugin would need the session list from `/v1`, which tabs must not reach.
- Give the tab the chat title too: the header right above it already shows it, and the tab would need more of the
  UI's data. It can be added to `init` later if a plugin really needs it.
- Render the inspector natively in the Web UI: that moves plugin logic into the UI and against "everything as
  plugins".

## Migration notes

- Manifests without `placement` behave exactly as before (sidebar). No config changes are needed.
- `/v1/plugins` `tabs[]` has a new `placement` field. Clients that ignore unknown fields are unaffected.
- The `#/t/context-inspector/context` link from the first version now shows "Вкладка … не найдена". Open a chat instead.
- `localStorage["sinty.chatView"]` is new and only holds `tab:<plugin>/<id>`.

## Known limitations

- Snapshots are still in memory only. Chats older than the plugin's start, and every chat after a restart, show the
  empty state until the next message. That is by design (privacy), and the empty state says so.
- Chat switches reload the iframe, because `Chat` remounts. The page state (pinned step, opened rows) is per frame and
  is lost on a switch. That is acceptable, since it is a different chat.
- A sub-agent's or delegate's steps show under their own session ids, not the parent chat's. Linking them is a
  follow-up.
- The view toggle shows the plugin's `title` only, with no badge or count of new steps.

## How to test

- `pnpm build && pnpm typecheck && pnpm test` (Linux and Windows). The plugin package has 7 tests, including
  `page.test.ts`. The core manifest and API tests are in `context-inspect.test.ts` and
  `context-inspector-plugin.test.ts`. `pnpm build` also builds the Web UI.
- `page.test.ts` covers:
  - no polling before `init`, and a message from a non-parent source ignored;
  - init with `sessionId`, then the empty state;
  - a live refresh that opens the first step, and following a newer step;
  - pinning an older step, which then survives a refresh;
  - `op: "session"` switching chats, with the stale reply for the old chat dropped;
  - `op: "session"` without an id, which shows «Чат не открыт».
- Headless check: a temp home with the scripted `recording-provider` and two chats, then Chromium via Playwright.
  It confirms:
  - the sidebar has no Контекст link, and the header shows `Чат, Журнал, Контекст`;
  - the iframe has `sandbox="allow-scripts"`, and the tab shows «2 ход(ов) · 3 шаг(ов)»;
  - after a switch to the other chat, the view stays on Контекст with the empty state;
  - a message sent there appears live as «Ход 1»;
  - Чат returns to the log.
- Screenshots of that run (`context-inspector-session.png`, `context-inspector-session-empty.png`) were taken on the
  build machine and are not committed.
- Results: Linux has core 89 tests (87 pass, 2 Windows-only skipped), context-inspector 7/7 and supervisor 4/4.
  Windows (Node 24.12.0, temp worktree, corepack pnpm 10.18.0) has core 89/89, context-inspector 7/7 and
  supervisor 4/4.
- Windows gotcha: run the tests in a shell without `SINTY_INSTALL_ROOT`. If it points at an installed copy, the
  host gives plugin processes `--allow-fs-read` for that install, not the worktree. The test fixtures then exit on
  start and most core tests fail with "exited with 1 during start".
