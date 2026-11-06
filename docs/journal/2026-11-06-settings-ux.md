# Settings UX

- Date: 2026-11-06
- Area: `apps/web` (`pages.tsx`, `supervisor-ui.tsx`, `staff.tsx`, `mcp-pane.tsx`, `style.css`, `cselect.tsx`) and `plugins/runninghub` (`tab-page.ts`)
- Plan step: Max approved `sinty-settings-ux-mock.html`, then asked to apply every Settings tab except «Навыки» and «Расход»
- PR: stacked UX PR #90 (`feat/ux-sidebar-composer`)

## What and why

The Settings pages still used the old sheet: an `h2`, native OS `<select>`s, checkbox walls, and "включён / выключен" text buttons, while the Agents card and chat had already moved to 65px bars, a centered 920px column, custom selects, tiles and toggles.

The live Settings shell now follows the approved mock for every tab except Skills and Usage:

- A 65px `.bar` with «Настройки» and the current section title.
- Content sits in a centered ~920px column (`padding: 20px max(16px, calc((100% - 920px) / 2))`).
- Основные: cards (Пресет / Интерфейс / Доступ), `CSelect`, appearance as a segmented control, streaming as a toggle. Token rotation is unchanged.
- Модели: cards for the install model, named routes (grid of `CSelect`s), enabled-model chips, provider cards with 36px letter, key badge, discover chips, and an accordion for a custom provider.
- Плагины / MCP: pill subtabs, search, 36px tiles, «у всех» mini-buttons, toggles. Install and MCP add forms keep the same API calls.
- Сотрудники: pill subtabs, 36px avatars, role `CSelect`, enabled toggle. The rights matrix and APIs are the same.
- Супервизор, Политика, Лимиты, Память и контекст, Контекст, Аудио, STT, Vision, Веб: still `SectionPane` over `/v1/settings/sections`. Named field groups render as accordions, booleans as toggles, selects as `CSelect`. Save still sends only changed fields.
- RunningHub: the iframe catalog (`tab-page.ts`) uses the same card / pills / grid language. All element ids and `postMessage` routes stay.
- Навыки (`skills-pane.tsx`) and Расход (`plugins/usage` iframe) were not restyled. They only pick up the shared Settings header and the centered sheet chrome that Skills already wraps in `.settings-sheet`.

`CSelect` moved from a local helper in `pages.tsx` to `cselect.tsx` so Settings, Staff, MCP and the Agents card share one control. Agents still pass `variant="cselect"`; other `ModelSelect` callers stay native unless they opt in.

## Files touched

- `apps/web/src/cselect.tsx` — shared `CSelect` and `Tog`.
- `apps/web/src/pages.tsx` — Settings header, General / Models / Plugins presentation.
- `apps/web/src/supervisor-ui.tsx` — `SectionPane` cards, accordions, selects, toggles.
- `apps/web/src/staff.tsx` — staff table, role select, enabled toggle, pills.
- `apps/web/src/mcp-pane.tsx` — MCP tiles, pills, add-form select.
- `apps/web/src/style.css` — settings page/sheet/cards/tiles/seg/set-row.
- `plugins/runninghub/src/tab-page.ts` — catalog iframe chrome.
- `CHANGELOG.md`, this entry, `docs/journal/README.md`.

## Design decisions

- **Shared form, not per-plugin copies.** Audio / STT / Vision / Web / Context / Memory / Supervisor / Policy / Limits all go through `SectionPane`, so one restyle covers the manifests without editing plugin JSON.
- **Scope visual overrides under `.settings-ux`.** Skills keeps `.tabs`, `.field` and the two-column `.plugin-grid`. Usage stays an iframe with its own CSS.
- **Do not invent fields.** RunningHub still has no separate «Адрес API» editor in the iframe; that line remains a status string from `/status`.
- **Keep save where the pane already saved.** Lifting every save handler into the header would rewire Models, SectionPane and plugins; in-pane «Сохранить» is the same contract, styled like the Agents primary button.

## Rejected alternatives

- Restyling Skills and Usage in the same pass. Max asked to polish those two first.
- Replacing the free-text install model with a closed list only. The control is a `CSelect`, but the current value stays visible even when it is not yet in the enabled list.

## Known limitations

- Custom select options do not yet show per-model subtitles on named routes (the mock had hints like "быстрый · по умолчанию"); the live list is still the enabled route names plus the existing empty label («как на установке»).
- The Settings header has no global Save; each form keeps its own button, hidden when nothing changed (`SectionPane`).

## How to test

Open Settings after a UI refresh. Check Основные (theme, streaming, token rotate), Модели (routes, chips, provider discover), Плагины (toggle / «у всех» / add), Сотрудники (role, enable, rights), Супервизор / Политика / Лимиты / Память / Контекст / Аудио / STT / Vision / Веб (save still writes only changed keys), MCP (catalog → add), RunningHub (search / run / history). Confirm Навыки and Расход look as they did, aside from the shared header.
