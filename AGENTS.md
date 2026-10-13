# Rules for coding agents working on this repository

This file is for agents (Claude Code, Codex, Cursor, Sinty itself) that edit the Sinty source tree.

## Boundaries

- `packages/core`, `packages/supervisor` and `schemas/` define the protected core. Change them only when the task explicitly says so, and keep the core thin: if a feature can live in a plugin, it must live in a plugin.
- Contracts live in `packages/sdk/src/` and `docs/spec/`. Change a contract and its spec in the same commit.
- A new capability is a new plugin under `plugins/<name>/` with a `sinty.plugin.json` that validates against `schemas/plugin-manifest.schema.json`.

## Code

- TypeScript, ESM, Node.js 24+. No runtime dependency in `core` unless it is unavoidable; justify every new one in the PR.
- Validate every external input with zod. Tool inputs are JSON Schema at the boundary.
- Every tool declares `sideEffects` and `idempotent` honestly. The journal and resume logic depend on it.
- No secrets in logs, events or model context. Use `secret://` references.

## Checks

```sh
pnpm install
pnpm typecheck
pnpm test
```

## Docs

- User-facing behaviour change: update `README.md` and `README.ru.md`.
- Milestone status change: update `docs/roadmap.md`.
