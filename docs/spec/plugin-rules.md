# Rules for writing a Sinty plugin

Status: implemented, 2026-10-29 (`packages/core/src/access-registry.ts`, `accounts.ts`, `api/server.ts`). Fields of the manifest are described in [plugin-manifest.md](plugin-manifest.md); this
document says what a plugin must and must not do, and how its screens become access rights.

## 1. One plugin, one job

- A plugin does one thing a person can name: a channel, a board, a provider, a set of tools. Two unrelated jobs are
  two plugins.
- Name: `^[a-z][a-z0-9-]{1,63}$`, stable forever. The name is part of tool names (`<name>.*`), data folder
  (`$SINTY_HOME/data/<name>`), HTTP prefix (`/p/<name>`) and access resource ids (section 5). Renaming a plugin is a
  new plugin.
- Version: semver. A change in `permissions`, a removed tool, or a changed surface id (section 4) is a major bump.

## 2. Rights of the plugin process

- The process gets only what `permissions` lists; the host enforces it. Ask for the least: no `shell` unless the
  plugin runs programs, no `net` host the plugin does not call, `"$PUBLIC"` only for tools that read the open web.
- Secrets are read by name through `ctx.secrets`; a plugin never writes them to its data folder, logs or tool output.
- Writable storage is `$DATA` only. Another plugin's data folder is refused by the host.
- A tool declares honest `sideEffects`. `write` and `external` tools default to policy `ask` unless the human changes
  `policy.yaml`.

These rights govern the **plugin and the agent**. What a **person** may see and press is section 5.

## 3. Tools, routes, prompts

- Tool names: `<plugin>.<verb>` or `<plugin>.<noun>_<verb>`. Core names and the reserved prefixes (`web.*`, `skill.*`,
  core tools) fail the plugin at start.
- Every tool has an input schema in code (zod) and a one-line `description` written for the model.
- Write tools are idempotent when they can be (`idempotent: true`), or implement `recover(idempotencyKey)`.
- HTTP routes live under `/p/<plugin>`. A route a person reaches from a screen names that screen (section 5.3). A
  route with `public: true` is for outside callers (webhooks, OAuth callbacks) and must check its own secret.
- `ctx.systemSection` text is short and stable; it is cached with the system prompt. Per-turn data goes into context,
  not into the system zone.

## 4. Screens (surfaces)

A plugin shows UI only through its manifest. The Web UI never hard-codes a plugin page, link or settings pane.

| Surface | Manifest | Where it appears |
|---|---|---|
| Sidebar page | `ui.tabs[]` with `placement: "sidebar"` (default) | global left panel |
| Chat view | `ui.tabs[]` with `placement: "session"` | toggle in an open chat header, next to Чат / Журнал |
| Project view | `ui.tabs[]` with `placement: "project"` (new) | tab inside a project; the page gets `projectId` |
| Settings section | `settings` | Settings, under the core items |

Rules:

- `id` of a tab is stable, `^[a-z][a-z0-9-]{0,31}$`, unique inside the plugin. Changing it is a new surface: grants of
  the old one stop applying.
- `title` is what the person sees, in the language of the UI (Russian today), at most 40 characters.
- A tab page is a sandboxed iframe served by a route of the plugin and talks to the plugin only through the `tab/1`
  bridge. Bundled plugins whose page is part of the Web UI build (today «Канбан» and «Календарь») declare the same
  `ui.tabs` entry with `builtin: "<view>"` (new) instead of `path`; the UI renders its own component, and the entry
  still comes from the manifest.
- A plugin that is disabled or not running shows no surface and no rights row.

## 5. Every surface is an access right

### 5.1 Registry

The core builds the list of rights from what is installed, at start and after every plugin enable, disable, install
or reload. Nobody types it by hand.

| Resource id | Comes from | Row title in Права |
|---|---|---|
| `nav:<id>` | core items: Чаты вне проектов, Проекты, Агенты, Плагины, Сотрудники | fixed |
| `settings:<id>` | core settings: Основные, Модели, Супервизор, Лимиты, Память и контекст, Политика, UI Kit | section title |
| `ui:<plugin>/<tabId>` | each `ui.tabs[]` entry | tab title, plugin name as a hint |
| `ui:<plugin>/settings` | the plugin `settings` block | settings title |
| `project:<id>` | each project | project name |

`GET /v1/accounts/roles` returns this registry grouped as **Панель**, **Настройки**, **Плагины** (one block per
plugin with its surfaces) and **Проекты**. `GET /v1/auth/me` returns `can` for the same ids.

### 5.2 Defaults

- A new surface is closed for every role except the superadmin. Installing a plugin never widens anybody's access by
  itself.
- The superadmin sees new rows marked «новое» in Права until they save that role once.
- Disabling or removing a plugin hides its rows and its screens. Grants stay in `accounts.db`, so enabling it again
  restores the same access. Права has «Убрать права удалённых плагинов» for cleanup.

### 5.3 What the boxes mean

| Box | On a sidebar, chat or project view | On a settings section |
|---|---|---|
| Смотреть | the item is in the panel and the page opens | the section is listed and readable |
| Добавлять | routes declared `access: "add"` | — |
| Править | routes declared `access: "edit"` | Save works |
| Удалять | routes declared `access: "delete"` | — |

A route a person reaches from a screen is registered as
`ctx.http({ method, path, surface: "<tabId>" | "settings", access?: "view" | "add" | "edit" | "delete", handler })`.
Without `access` the core maps the method: `GET`/`HEAD` → view, `POST` → add, `PUT`/`PATCH` → edit, `DELETE` → delete.
Without `surface` the route serves the plugin's first tab, else its settings. A plugin with no surface has no
person-facing routes: only the machine token and `public` routes reach it.

### 5.4 Combined checks

- Chat view: the person must open the chat (its project, or «Чаты вне проектов») **and** have the view surface.
- Project view: the project box **and** the surface box.
- «Проекты» off hides every project, whatever the project boxes say.
- The rights apply to people in the Web UI and the HTTP API. An agent's tools are still governed by `policy.yaml` and
  the agent card; a person cannot reach a plugin's data through an agent they are not allowed to use.

### 5.5 Who may change rights

Unchanged from [staff accounts](../journal/2026-10-28-staff-access-fix.md): the superadmin, or a role with
«Сотрудники → Править», which may grant only boxes its own role has, and not to its own role.

## 6. Settings

- Fields are declared in `settings.fields`; defaults come from the manifest `config`. Saved values go to
  `config.yaml` `plugins.config.<name>`.
- A field never holds a secret. Secrets are set through `sinty secret set` or a dedicated secret field type when it
  exists.
- A setting that needs a restart says so in `help`.

## 7. Tests and docs

- `tests` runs without network and without real secrets. The patch pipeline runs the same files.
- `README.md` in the plugin folder: what it does, tools, surfaces with their rights ids, settings, permissions and
  why each is needed.
- A plugin that ships in the install has a journal entry when its surfaces or permissions change.

## 8. Migration from today

| Today | After |
|---|---|
| `nav:skills` | `ui:skills/settings` |
| `nav:mcp` | `ui:mcp-catalog/settings` |
| `nav:board` | `ui:kanban/board` (kanban gets a `ui.tabs` entry with `builtin: "board"`) |
| `nav:calendar` | `ui:scheduler/calendar` (`builtin: "calendar"`) |
| `nav:settings` | split into `settings:general`, `settings:models`, `settings:supervisor`, `settings:limits`, `settings:memory`, `settings:policy`; UI Kit becomes `settings:uikit` |
| Контекст (chat view, mapped to `nav:chats`) | `ui:context-inspector/context` |
| Контекст, Vision, Веб settings (under `nav:settings`) | `ui:context-inspector/settings`, `ui:tool-vision/settings`, `ui:tool-web/settings` |

Existing grants are copied to the new ids once, on the first start of the new version. The hard-coded plugin
mappings in `server.ts` (`pluginResource`, `sectionResource`) and in the Web UI (`sideTabResource`,
`settingsResource`, `hasKanban`, `hasScheduler`) are removed.
