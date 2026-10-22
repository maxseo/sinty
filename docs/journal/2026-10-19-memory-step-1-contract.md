# Memory step 1: the memory contract (spec + SDK types)

- Date: 2026-10-19
- Area: packages/sdk, docs/spec, plugin manifest
- Plan step: memory plan, step 1
- Commits: `feat(sdk): memory step 1…`
- PR: [#1](https://github.com/maxseo/sinty/pull/1) (merge `bb47710`)

## What and why

Before moving code, the contract between the core and memory plugins is written down so that steps 2–6 implement
one agreed shape instead of growing one ad hoc:

- `docs/spec/memory.md` — vocabulary (tier, scope, provider, processor, router, context block), visibility rule,
  the turn lifecycle with the exact hook points, hook timeouts and failure behaviour, the afterTurn queue, recall
  budget and trust rules, `ctx.models`, builtin vector search, experiments, events and config.
- `packages/sdk/src/memory.ts` — `TurnInfo`, `MemoryRecord`, `RecallQuery`, `MemoryWrite`,
  `MemoryProviderDefinition` (alias `MemoryProvider`), `MemoryProcessorDefinition` (alias `MemoryProcessor`) with
  hooks `onTurnStart / afterRecall / beforeContext / afterTurn / onCompaction / onWrite`, `RecallPlan`,
  `ContextBlock`, `CompactionInput/Result`, `ModelsApi` (`complete`, `embed`), `EmbedProviderRequest`.
- `PluginContext` gains `ctx.models` and `ctx.memory.{provider, processor}`; `ProviderDefinition` gains optional
  `embed()`; `PluginKind` gains `"memory"`; `PluginPermissions` gains `models: string[]`.
- Manifest validation (`host/manifest.ts`) and `schemas/plugin-manifest.schema.json` accept the new kind and
  permission.
- Events added to `EventDataMap`: `memory.recalled`, `memory.compacted`, `memory.degraded`, `memory.experiment`,
  `models.called` (`memory.written` came in step 0).
- The runner exposes `ctx.models` / `ctx.memory` as stubs that reject or warn; step 3/4 replace them. This keeps
  every commit buildable.

## Files touched

`packages/sdk/src/memory.ts` (new), `packages/sdk/src/plugin.ts`, `packages/sdk/src/index.ts`,
`packages/sdk/src/events.ts`, `packages/core/src/host/manifest.ts`, `packages/core/src/host/runner.ts`,
`schemas/plugin-manifest.schema.json`, `docs/spec/memory.md` (new).

## Design decisions

- **Provider vs processor split.** Stores (where data lives) and policies (when to recall, what to keep) change for
  different reasons. A vault plugin is only a provider; a fact extractor is only a processor; the builtin store is a
  provider that the router always has.
- **Hooks return values instead of mutating.** Every hook returns the new value or nothing, so the router can keep
  the previous value on timeout/failure and the order of processors is explicit.
- **Models only through the core.** `ctx.models` with route names (`default`, `cheap`, `embed`) instead of giving
  plugins API keys: keys stay in the secret store, usage is accounted and journaled, budgets apply.
- **`permissions.models`** lists routes, so a human sees in the manifest that a plugin spends tokens.

## Rejected alternatives

- A single `MemoryPlugin` interface with optional everything: harder to reason about which plugin owns storage.
- Letting memory plugins be `context` plugins (the old approach): they saw the whole prompt, had no recall
  budget, no trust marking, and ran on every step.
- Passing `ProviderEndpoint` with the API key to plugins for embeddings: leaks secrets into plugin processes.

## Migration notes

None for users. Plugin authors: `PluginContext` has two new members; plugins that implement `PluginContext`
themselves (test doubles) must add them.

## Known limitations

- In this commit `ctx.models` and `ctx.memory` are stubs; they are wired in steps 3 and 4.

## How to test

`pnpm build` (type-level change). The spec is reviewed by reading; behaviour is tested from step 2 on.
