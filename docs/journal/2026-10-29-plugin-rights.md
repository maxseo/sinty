# Plugin screens become access rights

Follows [Staff access fix](2026-10-28-staff-access-fix.md). Rules: [plugin-rules.md](../spec/plugin-rules.md).

## What changed

`packages/core/src/access-registry.ts` builds the list of rights on every request from what is running: core panel items (`nav:*`), core settings (`settings:general`, `settings:models`, `settings:uikit` and one per core section), one block per plugin with its `ui.tabs` (`ui:<plugin>/<tab>`) and settings section (`ui:<plugin>/settings`), and projects. Права renders these blocks. `GET /v1/auth/me` answers `can` for every row.

- A row that appears after a role was last saved is marked «новое» and stays closed until someone ticks it (`resources_seen`, `roles.reviewed_at`). The first build on an install counts everything as old.
- A disabled plugin's rows are hidden; its grants are kept. `POST /v1/accounts/grants/orphans` (superadmin, button «Убрать права удалённых плагинов») drops grants of uninstalled plugins and deleted projects.
- Manifest tabs take `builtin` instead of `path` for a page of the core UI; kanban (`board`) and scheduler (`calendar`) declare theirs, so the core no longer hard-codes them. New placement `project`: a tab under an open project, `#/t/<plugin>/<tab>/<projectId>`, told `projectId`.
- `ctx.http` takes `surface` and `access`. A person's call to `/p/<plugin>/…` needs that right; a route on a `session` tab also needs the chat in `?session=`, a `project` tab the project. A plugin with no screen has no routes for people.
- `/v1/plugins` sends only tabs the person may open. `/v1/settings` and its PUT check `settings:general`, `settings:models` and `nav:plugins` separately; `/v1/supervisor` checks `settings:supervisor`.
- Grants on `nav:board`, `nav:calendar`, `nav:skills`, `nav:mcp`, `nav:settings` move once to the new ids (`meta.grants_v2`); `nav:chats` also opens the Контекст chat tab as before.

## Why

Права listed only the core panel. Контекст, Vision, Веб and the core sections shared one «Настройки» box or none, UI Kit had none, and a newly installed plugin's tab was visible to everyone with no row to close it.

## Test

`packages/core/src/__tests__/access-registry.test.ts`: registry rows and disabled plugins, route rights by surface and method, the one-time migration, «новое», orphan cleanup, and a person who gets a plugin tab and its routes only with that right and only for chats they see. `accounts-access.test.ts` uses `settings:policy` instead of `nav:skills`.

## Not in this change

Kanban and scheduler data routes are not filtered by project yet; they check the tab right only.
