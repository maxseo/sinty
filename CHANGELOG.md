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

### Changed
- The memory profile and recent-journal blocks only show facts the speaking persona and chat may see (user-wide,
  own agent facts, this chat), matching `memory.recall`.
- Agent-scoped memory uses the roster persona id instead of `config.agent.name` when a persona speaks.
- Core memory keeps one SQLite connection open instead of reopening `memory.db` on every step.
- A plugin that registers a tool with a core tool name (for example `memory.write`) now fails to start; two plugins
  with the same tool name produce a warning.

### Removed
- `plugins/memory` and its registry entry. It was always shadowed by the core memory tools.

### Fixed
- The two Windows-only shell sandbox tests no longer fail on Linux CI; they are skipped off Windows (TODO).
