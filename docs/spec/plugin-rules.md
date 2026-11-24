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
| Agent card | `ui.tabs[]` with `placement: "agent"` | tab on the agent card, after MCP and before Сохранить; the page gets `agentId` |
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

## 9. Plugins the agent writes

The agent writes a new plugin with the core tool `plugin.create` `{ plugin, reason, files }`. It goes through the patch
pipeline: staging copy, load check and `*.test.*` files in the sandbox, then `plugin.apply_patch`, git commit,
hot start and canary. Code: `packages/core/src/agent-plugins.ts`, `patches.ts` (`create`).

- **A human approves every new plugin.** `plugin.apply_patch` for a plugin that does not exist yet asks a human even
  when policy says `allow`. Applying writes the folder `$SINTY_HOME/plugins/<name>`, adds the name to `config.yaml`
  `plugins.enabled` and to the speaking agent's card, and starts it.
- **The core marks it.** The name goes to `$SINTY_HOME/plugins/.agent-made.json`. That file is outside every plugin
  folder, so no patch can remove the mark. A rollback that removes the plugin removes the mark.
- **Narrower manifest.** Checked when the plugin is created, on every later patch, and on every start:

| Allowed | Not allowed |
|---|---|
| `runtime: "node"`, `entry` a `.ts`, `.mjs` or `.js` file | `mcp-stdio`, `http` (MCP servers go through `mcp.install`) |
| kinds `tool`, `ui`, `schedule`, `event` | `provider`, `context`, `channel`, `server`, `memory` |
| `fs.write` `$DATA` or inside it; `fs.read` also `$PLUGIN` | any other path, `$WORKSPACE`, `$CONFIG.*` |
| `net` hosts (still cut by `policy.yaml net.allow`), `"$PUBLIC"` | `shell`, `browser` (they open child processes) |
| `secrets` by name, `models` routes | `env`, `context` |
| `agent: ["sessions.read"]` | `sessions.write` |
| tools named `<plugin>.<verb>` | other names, `defaultPolicy: "allow"` |
| `ui.tabs` with `path` | `ui.static`, `builtin`, `editable: false` |

- **Runtime checks.** On start the host refuses an agent-made plugin that registers a tool outside `<plugin>.*`, a model
  provider, or a `public` route other than the `GET` page of one of its `ui.tabs`.
- **No chat data by default.** Without `permissions.agent: ["sessions.read"]` the plugin gets no journal reads and no
  events, whatever it subscribes to.
- **Screens are closed.** Its tabs and settings appear in Права closed for everyone but the superadmin (section 5.2).

To give such a plugin more than this table, a human edits its folder by hand or installs it from a path; the agent
cannot.

### Narrow dynamic tool metadata capability

`tab/1` additionally supports `op: "dynamic-tools.catalog"` ONLY for plugin `dynamic-tools`, tab `settings`. The parent `init` supplies that iframe instance's `catalogNonce`; requests echo it as `nonce`. The bridge verifies exact source Window, sandbox origin `null`, plugin/tab and nonce, and rejects endpoint/method/body/query/project/agent/session fields. It uses only the parent's ordinary authenticated GET `/v1/agent` and GET `/v1/plugins`, forwarding `{ tools: [{name,description,plugin}], registryOnly: true }` after field stripping and size bounds. No auth, cookie, schema, config, provider details, history or execution capability is transferred. This does not authorize a plugin or agent to call any tool. Runtime discovery remains scoped to the provider request's permitted true schemas. Other plugins have no new API reachability; generic same-plugin `get`/`post` remains unchanged.


## Staged vNext package metadata / update foundation (not deployed)

`categories?: ("system" | "functional" | "ui")[]` describes purpose; `kinds` still describes extension points, `permissions` is the only grant declaration. Omitted categories preserve legacy manifests (display can use inferredCategories). No category enables privileged access.

`compatibility?: { core?, sdk?, protocol?, platforms?, architectures? }`: core/SDK use independent strict-SemVer comparator AND ranges, e.g. `>=0.5.1 <0.6.0` and `>=0.0.1 <0.1.0`. At most four comparators, no wildcard/caret/tilde/OR; prereleases require an explicit same-base prerelease comparator. `protocol` is exact; platforms win32/linux/darwin, architectures x64/arm64. Unsupported or unsatisfied declarations fail closed BEFORE old plugin unload. These are staged fields: deployed old0.5.1 parser cannot accept them until its update.

`changelog?: "CHANGELOG.md"` is a bounded relative package file path, never URL/parent traversal; declared file must be included. Existing packages without metadata remain valid. New authoring requires purpose, versioned history, compatibility, minimal permissions and tests. Single developer command: `node scripts/plugin-version.mjs check`; `node scripts/plugin-version.mjs bump <name> <new-version> <change-note>` updates manifest/package/changelog together, never publishes. Manifest version is authoritative; SDK0.0.1 is NOT forcibly made0.5.1. Permission/surface changes follow the existing breaking-change rule above.

Home path/npm updates now stage and validate, quiesce only selected plugin, retain previous directory under managed .rollback, activate/reload and atomically persist enablement only after readiness. Changed permissions require exact owner-reviewed old/new fingerprints; categories cannot suppress review. Failed validation does not interrupt old runtime; failed activation restores package and old runtime; failed restoration reports rollback_failed. Config/data/secrets are not package replacement targets. Bundled overwrite prohibition remains. Local path/npm packages are explicitly unsigned/unverified-publisher sources, not signed catalog installs. Materialized safe regular files only: links/hardlinks/PAX/GNU extended headers are rejected in this bounded first archive reader; no npm install-script fallback. Signed catalog primitives do NOT constitute a deployed catalog or download client.


## Signed distribution and update contracts (2026-11)
Use scripts/plugin-version.mjs to keep manifest/package versions and CHANGELOG aligned. Publish built, self-contained regular files with scripts/plugin-publish.mjs: explicit --dir, --out, --base HTTPS URL, --key owner-selected Ed25519 private-key file, --publisher ID, --files allowlist. No lifecycle scripts/dependency installation occurs on the receiver; bundle non-SDK runtime dependencies. Packages use bounded regular-file USTAR; this publisher supports names <=100 UTF-8 bytes and compressed artifacts <=20MB. Links and signing-key material are rejected. Do not publish credentials. Catalog signatures authenticate the index; the verified SHA-256 binds its immutable package version. Do not describe this as a separate package signature.
Manifest updateMode defaults to restart. rpc-only is an explicit author contract: no detached work/background timers that survive known host RPCs, no untracked child/background jobs or incompatible data migration. Active hot updates require BOTH installed and candidate manifests to declare rpc-only; otherwise the manager refuses activation and reports restart-required. This is not a sandbox or a proof that arbitrary plugin code is quiet. DATA changes during failed activation require owner review; no automatic DATA rollback/migration is promised.
UI placement plugins renders inside Settings > Plugins, not the sidebar. For ordinary custom plugin pages use path and the existing sandboxed PluginTab bridge. builtin identifiers are core-owned UI implementations; plugin-catalog is the actual bundled catalog client UI. Declare a tab only when a user-facing workflow needs it. categories, kinds, UI location, updateMode and permissions remain separate; none grant capabilities automatically.


### Managed lifecycle (pt309u, staged)
A request-only executable plugin may declare updateMode: rpc-only only if it creates no autonomous work. A plugin with timers/jobs/background callbacks must instead declare updateMode: lifecycle and register optional ctx.lifecycle({pause: async()=>{},resume: async()=>{}}). Pause must stop new autonomous dispatch and await already-running plugin jobs before acknowledgement; resume must be idempotent and restore paused dispatch after a failed core drain. The host checks the actual registered capability, not just the manifest claim. Schedule/channel/server/event kinds cannot bypass this via rpc-only. Unsupported/restart-required plugins remain blocked for managed hot handover; no detached-process cleanup or data-migration safety is implied. Existing SDK contexts without lifecycle remain valid; it is optional. See scheduler source as the implemented example.
