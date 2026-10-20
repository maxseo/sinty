# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Engineering reasoning for each change lives in
[`docs/journal/`](docs/journal/README.md).

## [Unreleased]

### Added
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
- When the compaction summary fails the prompt is trimmed to the last 12 user turns instead of sending the whole
  history (journaled as `memory.degraded` / `memory.compacted {ok: false}`).
- The two Windows-only shell sandbox tests no longer fail on Linux CI; they are skipped off Windows (TODO).
