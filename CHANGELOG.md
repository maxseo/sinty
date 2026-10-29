# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Engineering reasoning for each change lives in
[`docs/journal/`](docs/journal/README.md).

## [Unreleased]

### Added
- Программы looks for FFmpeg, Python, ImageMagick and the Playwright Chromium on disk, not only on PATH. Diffusion's tab downloads the Windows installer instead of only naming the GitHub release.
- Plugin `diffusion`: agents open a Diffusion Studio project, inspect media, check the cut and export through the desktop app's `diffusion` command. `diffusion.generate` spends account credits and asks first. The tab says when the command is missing and shows the latest GitHub release.
- Plugin `runtimes`: `runtimes.status` and `runtimes.install` put FFmpeg, Python and ImageMagick on the machine with winget. Chrome is the Playwright Chromium already used by `web.screenshot`; `hyperframes.render` points Puppeteer at that file.
- Plugin `hyperframes`: agents save an HTML composition and render it with the HyperFrames CLI (`hyperframes.write`, `hyperframes.render`). The Hyperframes tab and `hyperframes.updates` compare the npm version and the GitHub `main` commit with the last seen mark and show when either moved. Needs Node 22, FFmpeg and Chrome on the machine.
- Site plugin: pages, posts, categories and templates in SQLite at `$SINTY_HOME/data/site/site.db`. The agent uses `site.write`, `site.publish`, `site.layout` and `site.template`. A `form` widget stores the client's name, email, phone, Telegram and message (`site.requests`, status pending). The plugin does not send mail or Telegram; the agent does, through a harness connector, to the address in those fields, then marks the row with `site.request`. Harness tabs: Страницы, Блог, Конструктор, Вход, Заявки. Visitors sign in at `/p/site/login`. OAuth buttons are not wired yet. Страницы creates an internal page: title, address, meta title, meta description and body. The front page is not created there. Конструктор is the dark canvas: type at the top, nested block, row and column frames, a properties panel, and publish. A category layout is the design for records in that category. Блог creates categories and posts. A template is a shared block, not a page. The Конструктор tab is a human editor: create a draft, add widgets in one column, publish. The same records stay available to the agent. The tab bridge can POST JSON to the plugin's own routes.
- `/p/site/chat` is the visitor chat: the first message opens a harness session and the reply is that turn. The Чаты tab lists the threads. The separate public frontend and a domain come next.
- Staff accounts: the first person created in Settings → Сотрудники is the superadmin. Roles grant view/add/edit/delete on panel sections and on each project. Sign-in is email and password; a one-hour reset link is issued from the employee row, and `sinty user password` sets a password from the server. The machine token from `sinty web` still has full access. A role with the «Сотрудники» box manages staff but cannot assign or touch a superadmin or widen its own rights; panel items without «Смотреть» are hidden, and the API refuses them too.
- Plugin screens are access rights. Every `ui.tabs` entry (`sidebar`, `session`, new `project`) and every plugin settings section appears in Права as `ui:<plugin>/<tab>` or `ui:<plugin>/settings`, grouped per plugin; core settings are split into `settings:<id>` (Основные, Модели, UI Kit, Супервизор, Лимиты, Память, Политика). A new screen is closed to everyone but the superadmin and marked «новое»; a disabled plugin's rows hide and keep their grants; «Убрать права удалённых плагинов» drops the rest. Kanban and Календарь are now manifest tabs (`builtin`). Routes may declare `surface` and `access`. Old `nav:board`, `nav:calendar`, `nav:skills`, `nav:mcp`, `nav:settings` grants migrate once. Rules: `docs/spec/plugin-rules.md`.
- `plugin.create`: the agent writes a new plugin. It is staged and tested like a patch; `plugin.apply_patch` for it always asks a human, then installs, enables and starts it. Agent-made plugins (listed in `$SINTY_HOME/plugins/.agent-made.json`) may not use `shell`, `browser`, `env`, `context`, `sessions.write`, kinds other than tool/ui/schedule/event, paths outside `$DATA`, foreign tool names or public routes other than a tab page; the host checks this on every start. Without `sessions.read` they get no journal or events. See `docs/spec/plugin-rules.md` section 9.
### Changed
- Stop bumps the turn generation before aborting. A tool result that arrives afterwards is journaled as `tool.call.failed` (`stale_turn`) without its payload, so the next turn does not treat it as success.
- Chat composer: one click or a retry of the same text reuses one idempotency key, so a double-click does not open a second turn.
- Scheduler: `schedule.create` takes `delaySeconds` for a one-shot delay, `at` for a clock time, and `cron` for a repeat. `sessionId` defaults to the current chat. Tick default is 1s.
- Scheduler calendar: month grid in the sidebar («Календарь») reads `GET /p/scheduler/occurrences`. Settings sidebar holds **UI Kit** (was the main-nav «Набор»). Old `#/kit` opens Settings → UI Kit.
- Kanban is a project board: columns Бэклог / К выполнению / В работе / Проверка / Готово, roster assignee and reviewer, dependencies, priority, label, and `notify` `chat` or `none`. Dragging a running card out of «В работе» interrupts it. Skill `kanban-lead`.

### Added
- Settings → **Модели**: named routes UI (`cheap`/`embed`/`vision`/`long`) for `models.routes`, plus `service.model`. Catalog list retitled «Включённые модели».
- Plugin **`tool-vision`** (default-on): tool `vision.look` reads an image under the session workspace (project chroot when set), calls `ctx.models.complete` with `ChatMessage.images` (route `vision` → `default`, override `plugins.config.tool-vision.modelRoute`), returns text. Policy **ask**. Cap 8 MB (chat blob parity). Companion skill `skills/vision-look` via `sinty skills add`. Needs openai-compat vision; Anthropic/Responses ignore images on side calls today.
- MCP install phase 3: skill `mcp-install` (when the user asks to add an MCP) and `mcp.install` **auto-bind** — default `bind: agent` adds the new home plugin to the speaking agent's roster list so tools work without the agent MCP tab; `bind: shared` / `none` supported. `POST /v1/plugins/mcp` still defaults to `none` (Settings UI).
- Settings → **MCP** curated catalog (phase 4): tab **Каталог** with one-click cards (GitHub, PostgreSQL, MySQL, Supabase, SQLite, Filesystem, Telegram, MAX, Memory). Prefills Добавить with ready `command`/`url` + `secret://` env hints; install still `POST /v1/plugins/mcp`. Excludes Fetch/Playwright/Brave (core web). Includes Memory MCP for KG try-out. Filesystem card = MCP for agents; visual harness file browser is follow-up.
- `web.fetch_file` (tool-web): download a public URL into a file under the session workspace (project chroot when `projectId` is set). Policy **ask** (`sideEffects: external`). Hard size limit default **20 MB** (`plugins.config.tool-web.maxFetchMb`, 1–20, no truncate). Optional request headers. Path escape refused.
- Plugin **`scheduler`** (opt-in): durable cron / fire-at jobs under `$SINTY_HOME/data/scheduler/`; tools `schedule.create` / `list` / `cancel`; tick wakes a session with `message.user` `channel: schedule` (journal + `GET /p/scheduler/wakes`). Not default-on.
- Settings → Навыки: list/viewer and «Добавить навык» (form, paste, folder, zip, command). `POST /p/skills/import`, `GET /p/skills/item`, `GET /p/skills/file`, `POST /v1/skills/install`, CLI `sinty skills add <folder-or.zip>`.
- Settings → **MCP** (plugin `mcp-catalog`): tabs Установленные | Добавить. List home/bundled MCP plugins (`mcp-stdio` / `http`), enable/disable; add via `POST /v1/plugins/mcp` (same as `mcp.install`). Secrets only `secret://…`. Curated catalog later; skill + auto-bind in phase 3.
- MCP install (phase 1): core tool `mcp.install` and `POST /v1/plugins/mcp` write a home plugin (`runtime: mcp-stdio` | `http`) under `$SINTY_HOME/plugins/<name>/`, enable it in config.yaml, and hot-start via `PluginHost.reload`. Policy **ask**. Secrets only as names / `secret://` refs (optional `env` map); never raw values. Catalog UI in phase 2; skill + per-agent auto-bind in phase 3.

- Settings section **Политика**: edit `policy.yaml` `mode` and `defaults` (none/read/write/external → allow|ask|deny) via `PUT /v1/settings/sections/policy`. Live without restart. Session «не спрашивай» unchanged. Dead Общие «Доступ» localStorage control removed; link points to Политика.

- Chat UI: unified muted status line («Агент думает…» / «Фон · …») without the white pill; optional **Стриминг ответа** toggle in Настройки → Общие (`sinty.prefs.streaming`, default on).
- Project workspace chroot: when a session has `projectId`, `fs.*`, `shell.run`, web screenshots, and `web.fetch_file` resolve relative paths against `workspace/projects/<slug>` (not the global workspace). Chats without a project keep the global root.
- Session policy trust: skip further policy `ask` in a chat (deny unchanged) via UI «Больше не спрашивать в этом чате»,
  approval `remember`, `POST /v1/sessions/:id/policy-grants`, or phrases like «не спрашивай» / "just do it". Journaled as
  `session.policy_grant`; tool calls still appear in the journal.
- Chat live background status: one updating «Фон · …» line instead of a wall of `task.progress` notes (journal keeps all events).
- Stacked approval cards for background children; skill `background-tasks` + tighter `responsive-turn` / `agent.task` background rules.

### Changed
- `vision.look` no longer sends `max_tokens`. Settings → Vision has a Reasoning switch, default off. Off sends DeepSeek `thinking: { type: "disabled" }`.
- `vision.look` accepts `paths`. Settings → Vision **Batch** (default 4, max 16) is how many images share one model request; the same prompt is repeated for the rest of the list inside that tool call.
- Long or parallel `agent.task` work goes to the background without an explicit human request. Short answers stay in the parent turn. Revert notes: `docs/journal/2026-10-26-background-by-size.md`.
- A background child blocked by the supervisor or the budget notifies the parent once (`task.completed` failed, do not relaunch) and the chat line shows «Фон · стоит». Revert notes: `docs/journal/2026-10-26-background-stall-notify.md`.
- Settings → **Лимиты**: plugin day budget (default 2_000_000), main-turn `maxOutputTokens`, background parallelism, tree token cap. Live, no restart. Revert notes: `docs/journal/2026-10-26-limits-section.md`.
- «Стоп всё» stays while the chat or a background child is running or blocked. «Ждут ответа» has × to interrupt that one turn. Revert notes: `docs/journal/2026-10-26-stop-while-blocked.md`.

### Fixed
- Settings saves no longer wipe `models.fallback` or `models.routes`: `PUT /v1/settings` omits fallback when unset; `saveNamedRoutes` deep-merges (omitted keys preserved). Regression tests in `named-routes.test.ts`.
- Project chat attachments: files attached in the web UI are also written to `workspace/projects/<slug>/_inbox/` (same project root as #25). Content-addressed `data/blobs` remains the model source; sessions without a projectId are unchanged.
- Settings → **Плагины**: tabs **Установленные | Добавить**. List shows the full harness catalog (install registry + `/plugins`, including opt-in-off like `scheduler`) with per-plugin enable/disable that writes `plugins.enabled` immediately (same as MCP). **Добавить** installs a local folder or npm package with `sinty.plugin.json` via `POST /v1/plugins/install` (copy into home plugins, enable, hot-start). `GET /v1/settings` uses `discoverPlugins` so disabled home plugins appear too.
- `agent.task` children that inherit the parent's `projectId` also inherit the parent's speaker when the project has no `agentIds` (and the child has none of its own). Empty projects no longer fall through to `models.default` for child turns; project `agentIds` still win when set.
- `agent.task` tool lists accept wire names (`web__search`) as well as canonical (`web.search`);
  wire-only lists no longer auto-deny every child web call with `not in this child turn's tool list`.
- Background `agent.task` approvals surface in the parent chat (`childPending` on
  `GET /v1/sessions/:id`); «Ждут ответа» opens the parent when the waiter is a child.
- Responsive turns UX: sidebar no longer lists `agent.task` child sessions as chats; children inherit the parent's
  `projectId`. After a human «Стоп всё» / interrupt, `task.completed` with `status: interrupted` is still journaled
  but the parent is not woken with `trigger: "task"` (so the model does not restart cancelled work). Plugin
  `responsive-turn` prompt updated accordingly.

### Added
- Background `agent.task` children emit `task.progress` on the parent (tool start/complete/deny/fail/approval)
  so the parent chat is not silent while the child works; Web UI shows short «Фон · …» notes.
- Responsive turns: `agent.task` accepts `background: true` and returns `{taskId,sessionId}` immediately; when the
  child ends the parent gets a `task.completed` journal event and, if idle, a turn with `trigger: "task"`. New core
  tool `agent.task_steer` appends into a running child by `sessionId` or `taskId`. `POST /v1/sessions/:id/stop-all`
  and the Web UI «Стоп всё» interrupt the session and every `agent.task` child. Blocking children pulse the parent's
  stall watch so a live child does not look hung. A message while a turn waits for approval is queued (no `409`).
  Config: `agent.taskMaxParallel` (default 3), `agent.taskTreeTokens` (default 0 = off). Default-on plugin
  `responsive-turn` adds the prompt rule (ack first, long work as background tasks); disable with
  `plugins.disabled: [responsive-turn]`.

- Memory recall by word form: facts are also indexed as stems (`facts_stem`; Snowball Russian in `stem.ts`, English
  through SQLite's porter tokenizer), with stemmed AND and OR stages after the exact AND. "столы новые" finds "новый
  стол", "cats runs" finds "cat ... running". Existing databases build the index on first open.
- Login token rotation: `sinty token rotate [--print]`, Settings → Основные → «Сменить токен входа» and
  `POST /v1/auth/rotate`. The old token stops working at once, also in a server that is already running; open event
  streams with it end with `event: auth.revoked`. `sinty token` prints the current token (the Web UI sign-in screen
  already pointed to this command, which did not exist). Refused with `409` for a literal `server.token` or a
  `SINTY_SECRET_API_TOKEN` override.
- Context window per model: `memory.contextTokens: auto` (new default) takes the chat model's window from
  `models.contextWindows["provider/model"]`, the provider's model list (`listModels()`, new `provider.list` host
  message; Anthropic `max_input_tokens`, OpenRouter/Groq/vLLM fields; cached in `data/context-windows.json`), or a
  sourced table (DeepSeek V4 1M, OpenAI gpt-4.1/gpt-4o/gpt-5), else 128000. A number still overrides it. Compaction
  scales its estimate by the provider's real prompt size of the previous step (`model.request.estTokens` vs
  `usage.inputTokens`). `GET /v1/models` reports `contextWindow` per route; `sinty doctor` prints it.
- Compaction cap: the dialogue is folded at min(65% of the window, `memory.compactCapTokens`), default 150000
  (`0` or `null`: no cap). Settings section **Память и контекст** edits it live; the snapshot's `window.compactBy`
  and the Контекст ring say which threshold applies.
- Fallback window check: before a fallback route is tried, its context window is resolved; a prompt that does not
  fit gets old tool results trimmed for that request only (`model.request.trimmedForWindow`), and a route that is
  still too small is skipped with `model.fallback` reason `window_too_small` (`window`, `need`). The primary request
  and the stored history are unchanged.
- Контекст tab: a ring with the model's window, how full the step's prompt is (real usage once known) and a tick
  where the dialogue is folded. Snapshot field `window`.
- SDK: `ModelInfo`, `openAIModelList()`; provider-anthropic implements `listModels()`.
- Memory vectors remember their embedding model and width (`facts_vec_meta`). Vector search ignores vectors of
  another `models.routes.embed` route (FTS still finds those facts); `sinty memory reembed` (old name `reindex`)
  replaces them and, after a `memory.dimensions` change, rebuilds `facts_vec`. `memory.reembed: auto` does it in the
  background on start. `sinty doctor` and a one-time `memory.degraded` report stale vectors.
- Linux sandbox for `shell.run` with bubblewrap: system folders and tool folders on `PATH` read-only, the workspace
  read-write, no home folder or Sinty secrets, no network and a cleared environment (`SINTY_SECRET_*` never passed).
  `config.yaml` `shell.sandbox: auto | bwrap | off` (default `auto`), `shell.network`, `shell.passEnv`. Without a
  usable `bwrap`, `auto` runs commands as before with one warning; `bwrap` and policy `mode: strict` refuse with
  `sandbox_unavailable`. `sinty doctor` shows the state. Windows keeps its AppContainer cage unchanged.
- Plugin `skills` with the skills catalog and `skill.read`, `skill.files`, `skill.read_file`, `skill.write_file`,
  `skill.edit`, `skill.write` (moved out of the core; same names, descriptions, input schemas, error codes and
  hints; `skill.*` names reserved for it). On by default: `plugins.disabled: [skills]` or unticking it in Settings
  turns it off, an agent card's `excludedPlugins` hides it from one agent. Settings section **Навыки**:
  `catalogLimit` (default 60). `GET /p/skills/list`; `GET /v1/roster/skills` forwards there.
- `ctx.systemSection(name, render, { order, kind })`: a plugin block in the static zone of the prompt, right after the
  system prompt, rendered for the speaking agent; a failed or slow section repeats its last good text.
- `ctx.net.public.fetch` option `truncate`: over `maxBytes` the first `maxBytes` decoded bytes come back with
  `response.truncated` instead of a `too_large` failure. Off by default (downloads and binary bodies keep the limit).
- Supervisor detector `external_error` for failures where the target site or the network refused
  (`EXTERNAL_ERROR_CODES`: `http_4xx`, `http_5xx`, `too_large`, `timeout`, `net_failed`). Its notices never stop the
  turn, do not count toward `maxNoticesPerTurn`, carry no docs or incidents and never lead to a patch suggestion.
- `tool-web`: `web.interact` and `web.screenshot` return the page's HTTP `status` and, for an error, captcha or
  anti-bot page, `blocked` with a note for the model. `web.read` marks a page cut at `maxPageKb` with
  `truncated: true` and `…[truncated]`. Setting `acceptLanguage` (Settings → Веб → Accept-Language).
- Journal table `migrations` for one-time data fixes (`Journal.once`), and `Journal.dropIncidents`.
- Plugin `tool-web` with `web.search`, `web.read`, `web.links`, `web.screenshot` and `web.interact` (moved out of the
  core, same names, descriptions and input schemas). It is on by default; `plugins.disabled: [tool-web]` or unticking
  it in Settings turns it off. Settings section **Веб**: search engine (DuckDuckGo or your own SearXNG), result
  count, timeouts, page size and text limits, user agent, screenshot folder, allowed private addresses.
- `ctx.net.public` for plugins with `permissions.net: ["$PUBLIC"]`: `fetch`, `check` and, with the new
  `permissions.browser`, `proxy()` for a headless browser. See `docs/spec/net-public.md`.
- `config.yaml` `plugins.disabled` for default-on bundled plugins.
- Supervisor settings in `config.yaml` `supervisor:`, editable in the Web UI under Settings → **Супервизор** and applied
  without a restart:
  - `checks.{toolErrors,loop,budget,badOutput}`, `escalate`, `loopBlockAfter`, `repeatFailures`, `patchAfterTurns`,
    `maxNoticesPerDetector`, `useIncidents`, `stallBlock`;
  - `budget.{tokens,steps,seconds,count,cachedWeight,warnAt,stop}`. Unset numbers fall back to `policy.yaml
    budgets.turn`.
  - See `docs/spec/supervisor.md`.
- Budget token count `supervisor.budget.count`: `weighted` (default: cached prompt tokens at `cachedWeight` 0.1),
  `uncached` or `all`.
- Settings sections: plugins declare `settings` in their manifest (typed fields over their `config`), and the Web UI
  shows them under Settings next to Основные / Модели / Плагины. API: `GET /v1/settings/sections`,
  `PUT /v1/settings/sections/:id`. `context-inspector` declares one («Контекст»: `keep`, `maxMb`).
- Chat header tab **Супервизор**: that chat's remarks, stops, incidents and patches, with «Все чаты» for the whole
  install. `/v1/supervisor?sessionId=`.
- Sidebar block «Ждут ответа» listing chats that wait for a human (approval, question, supervisor or budget stop).
- Prompt caching (`docs/spec/protocol.md`, "Prompt caching"): every model request now only appends to the previous
  one, between steps, turns and restarts, so DeepSeek/OpenAI/Anthropic can bill the repeated prefix as cache hits.
  The core marks the end of stable zones with `ChatMessage.cacheHint` (`static`, `session`, `turn`) and passes a
  per-chat `ProviderRequest.cacheKey`; provider plugins apply them.
- Events `context.turn` (the frozen per-turn context: time with zone, recall, memory updates) and `memory.snapshot`
  (the session's frozen memory block, refreshed at compaction or when another agent speaks).
- `usage.recorded` gains `cacheMissTokens` and `cacheWriteTokens` next to `cachedTokens`.
- `provider-anthropic`: `cache_control` breakpoints on the hinted blocks (at most 4), options `promptCache: false`
  and `cacheTtl: "1h"`; cache reads/writes are added to `inputTokens`.
- `provider-openai-compat`: `options.promptCacheKey` (sent by default only to `api.openai.com`); DeepSeek
  `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` are recorded.
- `provider-openai-responses`: `prompt_cache_key` from the chat (off with `options.promptCacheKey: false`).
- Context snapshots: part kind `turn` with its `blocks`, `parts[].cacheHint`, `cache` (`hints`, `cacheable`,
  `reused` vs the previous step) and `contexts[].reordered`. The **Контекст** tab shows the cache boundary, where the
  cached prefix broke, and the provider's real input / from-cache / not-from-cache / cache-write tokens per step
  next to the estimates («кэш N%» in the step list).
- Tests: `packages/core/src/__tests__/prompt-cache.test.ts` (byte-identical prefixes across steps, turns and a
  restart; stepped compaction; append-only context plugins; plugin order; openai-compat and Anthropic wire bodies and
  usage) and unit tests in the three provider plugins.
- `sinty memory reindex [--dry-run] [--batch 64] [--json]`: embeds facts that have no vector yet through
  `models.routes.embed`; batched, idempotent, with progress (`MemoryRouter.reindexVectors`).
- Context snapshots: plugins with `permissions.context: ["inspect"]` that the human lists in `plugins.inspect` get
  `ctx.onContextSnapshot(snapshot)` for every model step. A snapshot holds the exact messages sent to the provider,
  labelled by part (system, skills, memory, summary, recall, processor, plugin, dialogue), with token estimates,
  profile facts, recall records, memory hook traces, context-plugin diffs and tool schemas. Secrets are redacted.
  Off by default, and nothing is built without an inspector (`docs/spec/context-inspect.md`).
- Manifest `ui.tabs`: plugins can add Web UI tabs. They run in a sandboxed iframe (opaque origin) and reach their
  own plugin's GET routes only through the `tab/1` postMessage bridge. `/v1/plugins` lists `tabs` and `inspector`.
- `plugins/context-inspector` (disabled by default): a **Контекст** view in the chat header (next to Чат/Журнал) with
  the open chat's per-step prompt parts, tokens, memory facts, recall, hooks and plugin context diffs. It follows the
  latest step live and shows an empty state for chats without snapshots. Snapshots are kept in memory only.
- `ui.tabs[].placement`: `"sidebar"` (default, a page in the left navigation) or `"session"` (a view toggle in an
  open chat's header). The `tab/1` bridge passes the chat to session tabs (`init.sessionId`, `op: "session"`), and
  `/v1/plugins` lists `placement` for every tab.
- Golden-prompt tests that pin what the model receives from memory (`packages/core/src/__tests__/golden`).
- `memory.written` journal event for facts stored by compaction summaries.
- Change journal in `docs/journal/` and this changelog.
- Memory contract: `docs/spec/memory.md` and SDK types (`MemoryProvider`, `MemoryProcessor` with hooks
  `onTurnStart`/`afterRecall`/`beforeContext`/`afterTurn`/`onCompaction`/`onWrite`, `ModelsApi`, `TurnInfo`,
  `ContextBlock`); manifest kind `memory` and permission `models`; events `memory.recalled`, `memory.compacted`,
  `memory.degraded`, `memory.experiment`, `models.called`.
- `ctx.models.complete/embed` for plugins through the core `ModelGateway`: route names (`default`, `cheap`,
  `embed`, `models.routes` keys), secrets stay in the core, `permissions.models`, per-plugin daily token budget
  (`models.pluginTokensPerDay`), `models.called` / `usage.recorded` journaling.
- `ProviderDefinition.embed()`; `provider-openai-compat` implements `POST /embeddings`.
- Memory plugins: `ctx.memory.provider()` / `ctx.memory.processor()` over IPC with per-call timeouts, a recall
  token budget, fallback to the builtin store with `memory.degraded`, automatic recall once per turn (journaled as
  `memory.recalled` and reused on resume), untrusted + secret-redacted external records, an `onWrite` filter, a
  durable afterTurn queue idempotent per turn, and `onCompaction`. New config: `memory.providers`, `memory.writeTo`,
  `memory.recall.{auto,limit,budgetTokens,timeoutMs}`, `memory.hooks.{timeoutMs,afterTurnTimeoutMs}`.
- Vector search in the builtin memory store when `models.routes.embed` is configured (falls back to full-text search
  with `memory.degraded` on errors or a width mismatch).
- `plugins/memory-obsidian` (disabled by default): read-only Markdown/Obsidian vault search with its own index.
- `plugins/fact-extractor` (disabled by default): extracts durable facts after each turn via the `cheap` route and
  filters secrets from memory writes.
- `$CONFIG.<key>` read grants in plugin manifests, resolved only from the human's `config.yaml`.
- `memory.experiments`: session-hash arms with recall overrides, `memory.experiment` events and shadow arms journaled
  as `memory.recalled {shadow: true}`.
- `sinty memory eval`: offline recall replay with hit rate on labeled queries, memory-block tokens and latency per arm.
- `Sinty.start({ background: false })` for offline tools.

### Changed
- Docs: project state for handoff. New `docs/plan.md` (the memory / minimal-core plan with the final status of every
  step and PR), `docs/README.md` (docs index and «Как подхватить проект»: what to read first, working rules), a
  "Done after 1.0" table in `docs/roadmap.md`, a refreshed `docs/backlog.md` (done items removed; new open items such
  as embeddings being off by default and how to enable them), an index of `docs/journal/` and PR numbers in every
  journal entry.
- Compaction folds at 65% of the chat model's context window (was always `memory.contextTokens`, default 128000).
  For a 1M-window model long chats keep far more history; set `memory.contextTokens: 128000` for the old behaviour.
- The skills catalog is now a system section of the `skills` plugin. The prompt is byte-identical (same text, place
  and `static` hint); context snapshots label it `source: skills`, `id: skills/catalog`. With the plugin off, or
  excluded for an agent, there is no catalog and the system prompt carries the `static` hint.
- `tool-web` errors keep their meaning: core codes (`net_blocked`, `too_large`, `timeout`, `net_failed`,
  `bad_request`) pass through, a site's non-2xx answer is `http_4xx` / `http_5xx` with the status and host in the
  message, argument mistakes are `invalid_args`, and only the rest is `web_failed`. Each gets its own hint; the
  "Private hosts are blocked" hint is only on `net_blocked`. 401/403/429 and too-large pages point to `web.interact`.
- `tool-web` defaults: `maxPageKb` 5000 (was 1500), and requests go out as a desktop Chrome with `accept` and
  `accept-language` headers instead of `Sinty/1.0` (an old saved `Sinty/1.0` also means the new default).
- Supervisor failure notices quote a tool's docs once per tool per turn, only the section under the heading that names
  the tool; `supervisor.docsMaxChars` defaults to 500 (was 1500). The `tool-web` README has a section per tool.
- "Failure #N … do not repeat" (level 2) counts failures of the same tool, code **and target** (url host, path, …), so
  reading three different shops is no longer a repeat.
- Incidents: only a later call of the same tool on the same target is a fix (another site read after a failure is
  not), external errors are never stored, and a failure quotes only incidents with the same tool, code and message
  key whose fix is not aimed at another host.
- The web tools are no longer core tools: `packages/core/src/web.ts` is gone and `playwright` moved from
  `@sinty/core` to `@sinty/plugin-tool-web`. Policies, approvals and the supervisor see the same tool names;
  `supervisedTools()` now reports them as `tool-web` tools, so the agent may patch them (for example the DuckDuckGo
  parser in `plugins/tool-web/src/search.ts`).
- `web.*` tool names are reserved for `tool-web`; another plugin that registers one fails to start.
- The left sidebar no longer has **Журнал** or **Супервизор**: both are chat-header tabs. `#/pending` and `#/supervisor` open the chat list.
- Budget stops count cost-weighted tokens by default instead of every prompt token. Set `supervisor.budget.count: all`
  for the old behaviour.
- The system prompt no longer contains the current time. The time goes, to the minute and with the time zone
  (`agent.timezone`, else the system zone), into the turn context written once per turn.
- Recall (`memory.recalled`) and new memory are no longer system messages after the memory block that change every
  turn: they travel in the turn context, placed before the turn's first human message and kept in the history.
- `beforeContext` memory hooks run once per turn on the turn context blocks, and their result is frozen; before they
  ran on every model step over all memory blocks.
- The memory block is a per-session snapshot; facts saved later reach the model once, in `<memory_updates>`.
- Compaction is stepped: the summary and what follows it are kept while they fit, instead of re-folding on every turn
  once the window was passed. Old tool results are shortened in steps of 8 turns.
- Tool schemas are sorted by wire name, and plugins keep their `plugins.enabled` order after a parallel start or a
  reload, so the tool list is the same on every call.
- Context plugins may only append: a contributor that edits, inserts or removes earlier messages keeps only what it
  appended after the last message (warned once per plugin).
- `provider-anthropic` sends `system` as text blocks and no longer merges later system messages into it (they go in
  place as user `<system>` text); `provider-openai-responses` builds `instructions` only from the leading system
  messages (later ones stay as `developer` items).
- Golden prompts regenerated for the new layout (`golden/compaction.json`, `golden/memory-tools.json`).
- Builtin full-text recall falls back from AND to OR (bm25-ranked) and then to word-prefix OR, so partial and
  inflected matches are found; full matches still rank first.
- `memory.write` through the tool now journals `memory.written` (one event per write), like every other write.
- The plugin token budget (`models.pluginTokensPerDay`) is stored per plugin and UTC day in `journal.db`
  (`plugin_model_usage`), so restarts no longer reset it.
- Shutdown waits only for an afterTurn drain that is already running; one-shot commands no longer start one.
- Memory goes through a single `MemoryRouter` in the core with the SQLite store as the `builtin:sqlite` provider;
  prompts and memory tool results are unchanged (golden tests).
- The memory profile and recent-journal blocks only show facts the speaking persona and chat may see (user-wide,
  own agent facts, this chat), matching `memory.recall`.
- Agent-scoped memory uses the roster persona id instead of `config.agent.name` when a persona speaks.
- Core memory keeps one SQLite connection open instead of reopening `memory.db` on every step.
- A plugin that registers a tool with a core tool name (for example `memory.write`) now fails to start; two plugins
  with the same tool name produce a warning.

- Docs: `architecture.md` and `backlog.md` describe the core memory router instead of the old `memory-sqlite` /
  `context-compress` plugin plans.

### Removed
- `plugins/memory` and its registry entry. It was always shadowed by the core memory tools.

### Fixed
- Settings → **Плагины**: tabs **Установленные | Добавить**. List shows the full harness catalog (install registry + `/plugins`, including opt-in-off like `scheduler`) with per-plugin enable/disable that writes `plugins.enabled` immediately (same as MCP). **Добавить** installs a local folder or npm package with `sinty.plugin.json` via `POST /v1/plugins/install` (copy into home plugins, enable, hot-start). `GET /v1/settings` uses `discoverPlugins` so disabled home plugins appear too.
- `sinty doctor` printed the compaction point as 65% of the window ("summary at 681574" for DeepSeek's 1M window)
  although compaction folds at `memory.compactCapTokens` (150000 by default) when that is lower. It now prints the
  point from the core's `compactPoint()` and says whether the cap or 65% of the window applies (`describeCompaction`,
  exported from `@sinty/core` with `compactCap`, `compactPoint` and `DEFAULT_COMPACT_CAP`).
- `tool-web` (and any plugin with `permissions.shell`, `permissions.browser` or runtime `mcp-stdio`) no longer logs
  Node's `[PERM0002] SecurityWarning: The flag --allow-child-process must be used with extreme caution` as a warning
  on every start. Only that warning code is switched off, only in those processes (`--disable-warning=PERM0002`;
  on Node releases that print it without a code, such as 24.12, `--disable-warning=SecurityWarning` in those
  processes); the host logs one info line naming the grant instead. Other warnings are unaffected.
- The API read its login token once at start, and a running server kept the secrets it started with: a
  `sinty secret set` next to it had no effect until a restart, and the server's next secret write put the old values
  back. `SecretStore` now re-reads `secrets.json` when it changes.
- A `facts_vec` table of another width than `memory.dimensions` made every memory write with an embedding fail;
  vectors are now off (FTS only) until `sinty memory reembed`.
- A turn that read a few shops was stopped with "supervisor notices did not help (tool_error: 3, total 3)": site
  refusals (401, 404, a 1.5 MB page) counted as tool misuse toward `maxNoticesPerDetector`, every notice repeated the
  whole tool-web README, said "Private hosts are blocked" and offered an unrelated incident (another site's url as the
  fix for a 429). See `docs/journal/2026-10-21-web-errors-supervisor-notices.md`.
- `web.read` failed on pages over 1.5 MB (Yandex Market) instead of reading their beginning.
- `web.interact` reported a 403 captcha page as a normal result.
- The incidents stored by the old fix rule for `web.*` with code `web_failed` are dropped once on start.
- Web broken for roster agents after `tool-web` left the core: agent cards saved before it existed list their plugins
  explicitly without `tool-web`, so every `web.search` was denied with "this plugin is not on this agent". Default-on
  plugins (`DEFAULT_ON_PLUGINS`) are now on every agent unless its card lists them in the new `excludedPlugins`;
  the agent editor shows `tool-web` as «встроенный, у всех агентов» and unticking it writes `excludedPlugins`.
  `GET /v1/plugins` marks such plugins `defaultOn: true` (and `forAll: true`, whatever the shared list says).
- `agent.task` child turns were offered no tools at all (the allow list held `web.search`, the schemas `web_search`),
  and ran as the global persona. They now get exactly their list and speak as the parent's agent (persona, memory
  scope, plugins, exclusions); their memory snapshot stays in the child session.
- The memory snapshot changed on every model step of a long chat (prompt diverged at message 2, DeepSeek cache 0%):
  when the kept 12 user turns alone were over 65% of `memory.contextTokens`, the same head was folded again before
  every step, the summary came back worded differently and its facts were stored again, which rebuilt
  `memory.snapshot`. Now a head is folded once; folds happen only before the first model step of a turn (later steps
  fold only when the whole window would overflow); and when 12 turns are too long, fewer are kept (down to 2) so the
  next turn does not fold again. Golden `compaction.json` regenerated (3 folds instead of 4 in 16 turns).
- Журнал tab: the «Вызов» badge of tool rows rendered as a wide card over the tool name (it picked up the global `.tool` style).
- Chat agent selection: the core now picks the speaking agent from the chat's own `metadata.agentIds` first (what
  the Web UI saves when a chat is created with chosen participants), then from the project's agents (asked agent →
  project lead → first member), and only then falls back to the global `~/.sinty/AGENTS.md`. Before, a chat in a
  project with no agents (a project created with the sidebar "+") ignored the chat's agents: it got the global
  AGENTS.md, the name `Sinty`, and `Sinty`'s agent-scoped memory. Chats without a project but with `agentIds` are
  supported too; deleted agents are skipped.
- Web UI: a chat whose project has no agents and that has none of its own shows a warning that the global
  AGENTS.md is used. The chat header lists the same members as the core (an empty `agentIds` falls back to the
  project) and preselects the project lead.
- Context snapshots carry `persona` (`agent` with its name, or `global`); the **Контекст** tab shows it and warns when
  the global AGENTS.md is used because the chat has no agents.
- When the compaction summary fails the prompt is trimmed to the last 12 user turns instead of sending the whole
  history (journaled as `memory.degraded` / `memory.compacted {ok: false}`).
- The two Windows-only shell sandbox tests no longer fail on Linux CI; they are skipped off Windows (TODO).
- `sinty run` (and any `Sinty.stop()`) no longer loses afterTurn memory jobs: shutdown waits up to
  `memory.hooks.closeTimeoutMs` (default 15 s) for the queue while plugins still run; unfinished jobs stay `pending`
  with a warning and resume on the next start.
- Windows: golden prompt tests normalize path separators; `shell.ts` finds the tracked
  `packages/core/sandbox/ShellBox.exe` in a source checkout, so the shell sandbox works in a fresh clone.

### Security
- Web SSRF protection is a core service (`netguard.ts`) and covers more:
  - CGNAT `100.64.0.0/10`, IPv4-mapped/compatible, NAT64 and 6to4 forms (`::ffff:127.0.0.1`), `::`, site-local,
    multicast, reserved and documentation ranges are now refused too;
  - every DNS answer and every redirect hop is checked, and the socket connects to the checked address (no DNS
    rebinding window);
  - the browser runs behind a core proxy that applies the same checks to every connection, so a page can no longer
    load `http://127.0.0.1/...` or `169.254.169.254` sub-resources;
  - `allowPrivate` (Settings → Веб) lets named private host[:port] through; the core reads it from `config.yaml`
    only.
- Supervisor incidents and notices no longer store or show raw arguments:
  - text typed into pages (`web.interact` `type`) and password/token/secret fields are replaced by `[hidden]`;
  - long values are cut;
  - incidents stored earlier are masked at start;
  - `/v1/supervisor` masks again on output.
