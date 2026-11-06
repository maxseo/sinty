# Agents card UX

- Date: 2026-11-06
- Area: `apps/web` (`pages.tsx`, `style.css`)
- Plan step: Max approved `sinty-agents-ux-mock.html`, then asked to apply it on the live Agents page
- PR: stacked UX PR #90 (`feat/ux-sidebar-composer`)

## What and why

The Agents editor was still the old settings sheet: an `h2`, a long scroll of fields, text Enable/Disable buttons, a native OS `<select>`, and a Projects list under the card. Projects already live in the left sidebar, and the rest of the UI (sidebar rows, chat bar, 920px chat column) had moved on.

The live card now follows the approved mock:

- When no agent is selected, a short empty state ("Выберите агента слева" + "+ Новый агент").
- When an agent is open, a 65px `.bar` with a 36px circle avatar, name, specialization subtitle, pill tabs (Общее / Плагины / Навыки / MCP), and primary **Сохранить**.
- The editor sits in a centered ~920px column (`padding: 20px max(16px, calc((100% - 920px) / 2))`).
- Общее: persona (clickable 72px avatar upload, name + specialization in one row, summary), AGENTS.md in a mono code-card, an open **Модели** accordion (custom select + fallback chips) and a collapsed **Служебные вызовы** accordion (service model, compress, facts, stallSeconds).
- `ModelSelect` stays native on Settings. On this page it uses a `cselect` variant so the OS blue dropdown does not appear. `FallbackPick` is the same value/onChange contract, drawn as chips.
- Плагины / MCP / Навыки: tiles with a 36px letter circle, title, one-line description, and a toggle. Existing `togglePlugin` / skills checkbox logic is unchanged.
- The Projects list and create form are gone from this page. Project APIs used by the sidebar are untouched.

Save/load behavior is the same: `saveAgentForm`, default-on vs optional plugins, `excludedPlugins`, 200 KB avatar cap.

## Files touched

- `apps/web/src/pages.tsx` — AgentsPage layout, CSelect, ModelSelect `variant`, FallbackPick chips, AgentPluginTiles toggles.
- `apps/web/src/style.css` — agent bar/sheet/persona/code-card/accordion/cselect/tiles.
- `CHANGELOG.md`, this entry, `docs/journal/README.md`.

## Design decisions

- **Reuse `.bar` and `.tabs`.** The chat header already sets height 65px and pill tabs; the agent header is the same strip so the two panes line up.
- **Page-local custom select.** Settings still uses native `<select>` via `ModelSelect` without `variant`. Only the agent card asks for `variant="cselect"`.
- **Chips instead of a checkbox wall** for fallbacks, matching the mock. The stored value is still a space-separated route list.
- **Projects stay in the sidebar.** Creating or deleting a project from the agent card duplicated the left panel and mixed two objects on one page.

## Known limitations

- Custom select options do not yet show per-model subtitles (the mock had hints like "быстрый · по умолчанию"); the live list is the enabled route names.
- Small screens stack the persona row; tabs stay visible so the sections remain reachable.
