# Sidebar and composer UX

- Date: 2026-11-06
- Area: `apps/web` (`app.tsx`, `chat.tsx`, `style.css`, `icons.tsx`)
- Plan step: Max approved the HTML mocks, then asked to put them on the live UI and open a stacked PR
- Commits: this commit
- PR: (open with this branch, stacked on `cursor/usage-dashboard-a591` / PR #88)

## What and why

The chat is the core of the UI. A project is a shared sandbox (`workspace/projects/<name>`) for every chat inside it, not a chat mode. The old sidebar mixed projects as an accordion under a top nav of Agents and plugin tabs, and the footer held a theme toggle, logout and settings. That hid the project-as-container model and put chrome where Max wanted account, connectors and a future client update.

The live sidebar now matches the agreed mock: brand `S SYNTET harness` stays at the top; the root lists projects (letter in a colored circle) and chats outside a project; opening a project slides the root away the same way Agents already did; the same workspace tabs sit under the list in both places; the footer is the account initial, «Подключить прил…» and a bright update control. Theme stays in Settings → Основные.

The composer is an explicit pill that hangs in the chat with no outer tray. Empty it is one ~44px row (`+`, text, hold-to-talk mic, live wave). It grows up when the first line hits the right-hand buttons or attachments appear, up to six lines, then a thin scrollbar. Attachments sit above the text. When the form is tall, `+` / mic / send stay on the bottom row.

## Files touched

- `apps/web/src/app.tsx` — root vs project slide, letter avatars, bottom `SideTools`, account footer, project name passed into `Chat`.
- `apps/web/src/chat.tsx` — crumb header, pill composer, autosize, hold-to-record Speech Recognition hook, live-mode stub.
- `apps/web/src/style.css` — full-height sidebar, thin scrollbar without arrows, footer, composer compact/tall, segmented chat tabs.
- `apps/web/src/icons.tsx` — `IconWave`, `IconArrowUp`.
- `CHANGELOG.md`, `docs/journal/README.md`, this entry.

## Design decisions

- **Reuse the existing two-pane slide.** Settings and Agents still take the second pane and hide the workspace tabs. A focused project uses that same pane when neither settings nor Agents is open. Brand and footer stay fixed, like the previous Agents motion.
- **Same tabs, different query.** Builtin board/calendar keep `{ page: "board" }` / `{ page: "calendar" }`. Plugin tabs keep `{ page: "tab", plugin, tab }` and receive `projectId` only when the user is inside a project. That is how a tab's sandbox becomes `workspace` vs `workspace/projects/<name>` without inventing new routes.
- **Rights stay as they were.** New project still needs `nav:projects` + `add`. Loose chats and the new-chat button still need `nav:chats`. Agents still need `nav:agents`. Plugin tabs still go through `tabRight`.
- **Theme leaves the footer.** Appearance is already on Settings → Основные (`sinty.prefs` / `sinty.theme`). The footer toggle duplicated that and fought the account-menu sketch.
- **Connectors go to an MCP settings section when one exists**, otherwise Plugins. Usage in the account menu goes to the usage/Расход section when present (`plugin.usage` fallback). The update button is visible and says that a client updater is not wired yet; it must not pretend an install happened.
- **Voice input uses the browser Speech Recognition API** when present (hold to record, release to insert text). There is no composer call to `stt.transcribe` or `audio.listen` — those tools take a project file, not a live microphone. Live conversation (the wave button) is a stub with a hint.
- **Composer class `tall` is measured in `useLayoutEffect`** so wrap can be detected at the compact width (text between `+` and the right-hand buttons) before paint.

## Rejected alternatives

- Keeping the accordion of projects with nested chats. Max asked to drill in, like Agents, so the root can show projects and loose chats as peers.
- A third slide pane for projects next to settings/Agents. Two panes already match the existing motion; settings/Agents take priority over a focused project.
- Wiring the wave button to `audio.listen` or a WebRTC session. No live-talk protocol exists in the harness yet.
- Uploading a held recording to `stt.transcribe`. That tool expects a file already in the project; hooking a mic blob through blob upload would be a larger change than this UX step.

## Migration notes

No config or API changes. `sinty.openProjects` is still written when a project is created so older builds that read the accordion state do not lose it. The sidebar no longer expands projects in place.

## Known limitations

- The update button does not check or install a client build.
- Live talk is a visual stub.
- Hold-to-record depends on `SpeechRecognition` / `webkitSpeechRecognition`. Chromium on Windows usually has it; Firefox often does not, and then the button only shows the recording state plus a hint. It does not insert fake transcript text.
- Last-message previews in the chat list are not loaded; the subtitle is turn status or `updatedAt`.
- Builtin Канбан and Календарь remain global pages. They appear in both the root and a project, but they do not yet switch a project sandbox of their own.
- HyperFrames / `rhany` session-root path behavior is out of scope for this PR.

## How to test

- Empty workspace: only «Новый проект» and «Новый чат», then the footer.
- Create a project: name dialog, then the panel slides into that project. `+` next to the title opens the existing agent-picker chat dialog.
- Root shows projects and chats outside a project. Click a project, go back, confirm the root returns.
- Bottom tabs in the root open existing destinations without a `projectId`. The same tabs inside a project pass that project's id for plugin tabs. Agents still slides to the agents list.
- Account initial opens Параметры, Использование and Выйти. Theme is not in the footer. «Подключить прил…» opens Settings → MCP or Plugins.
- Open a project chat: header is `project / chat`, agent pill, status, segmented views. No second SYNTET mark in the chat header.
- Composer starts as one compact row. Type until the line hits the right-hand buttons: the form grows up. After six lines a thin scrollbar appears. Attach files: previews above the text, buttons stay at the bottom, 6px inset from the pill edge.
- Empty composer shows the wave control; any text or attachment turns it into send (arrow up). Hold the mic: recording state; release inserts speech text when the browser supports it.
- Toggle Settings → Основные appearance: sidebar and composer follow light and dark.

## Follow-up polish (circles / bar / footer)
- AgentsList now uses side-av + side-meta like ChatRow (36px, title, specialization as side-sub).
- .side-foot horizontal padding 16px; .brand/.bar min-height 60px so chat header lines up with left brand strip.
