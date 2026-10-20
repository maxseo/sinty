# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Engineering reasoning for each change lives in
[`docs/journal/`](docs/journal/README.md).

## [Unreleased]

### Added
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
