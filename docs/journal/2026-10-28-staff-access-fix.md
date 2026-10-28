# Staff access: admins, hidden sections, closed holes

Follows [Staff accounts](2026-10-28-staff-accounts.md).

## What changed

An admin role with the «Сотрудники» box manages staff without being superadmin. It cannot hand out the superadmin role, change, disable, delete or issue a reset link for a superadmin, change its own role, enabled flag or grants, delete itself or its own role, or grant a box its own role does not have. The server enforces each rule; the page only hides what would fail.

Panel boxes now also cover Агенты, Канбан, Календарь, Сотрудники and «Настройки установки» (Основные, Модели, core sections). A project box counts only while the role sees «Проекты». `GET /v1/auth/me` returns `can`, and the sidebar and settings list show only items with «Смотреть». The Навыки and MCP settings sections follow `nav:skills` and `nav:mcp`.

Holes closed for signed-in people:

- `POST /v1/auth/rotate` returned the machine token to any account. It is superadmin only now.
- `/p/<plugin>/…` accepted only the machine token. A person got 401 and the login form. It now takes a user token and checks the box of the panel item that shows the plugin.
- `/v1/settings`, `/v1/settings/sections`, plugin, skill and MCP installs, agent writes and model writes did not check roles.
- `/v1/pending`, `/v1/stream` and `/v1/supervisor` showed every session. They now show only sessions the role can open.
- Open event streams re-checked only the machine token, so a person's live updates dropped.

The staff page uses underline tabs, a person table with avatar or initials, an «Add» dialog, and a two-column «Права» view: roles on the left, «Панель» and «Проекты» tables on the right. The reset link uses `POST`. The page had been sending `GET`.

## Why

The first version gated every staff route on superadmin, showed every panel item to everyone, and left plugin and settings routes on the machine token only. An admin saw «Недостаточно прав» on Сотрудники and could open Навыки while every Навыки box was off.

## Test

`packages/core/src/__tests__/accounts-access.test.ts` signs in as an admin and checks each refusal above, plus empty sections and `can` in `/v1/auth/me`.

## Not in this change

Per-person exceptions, departments, and per-chat sharing. Plugin routes map to one panel item per plugin, not to the project of the data inside.
