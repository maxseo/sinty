# Memory step 2: builtin:sqlite provider and MemoryRouter

- Date: 2026-10-19
- Area: packages/core (memory-router.ts, memory-builtin.ts, agent.ts, sinty.ts)
- Plan step: memory plan, step 2
- Commits: `refactor(core): memory step 2…`

## What and why

The memory logic that lived inside `Agent` (prompt block, memory tools, compaction) moves behind one object,
`MemoryRouter`, so that later steps can add plugin providers, processors, budgets and journaling in one place
instead of scattering them through the turn loop.

- `memory-builtin.ts` — `BuiltinMemory` (`name = "builtin:sqlite"`) wraps `MemoryStore`: `block()`, `summary()`,
  `saveSummary()`, `write()`, `recall()`, `forget()`, `toRecord()` (to the SDK `MemoryRecord`).
- `memory-router.ts` — `MemoryRouter`:
  - owns the long-lived builtin store (one SQLite connection; `close()` from `Sinty.stop()`),
  - `contextMessages(ctx)` → memory block + `<conversation_summary>`,
  - `tool(name, args, ctx)` → `memory.write/recall/forget` with identical inputs and outputs,
  - `compact(input)` → the 65% / 12-user-turn compaction, summary save and summary facts (`memory.written`).
- `Agent` keeps the turn loop and the builtin summary model call (`summarize()`, moved to the model gateway in
  step 3) and asks the router for everything else. `AgentDeps.memory` is required; `Sinty` creates the router.

## Behaviour: 1:1

Proven by the golden-prompt tests captured on main before any change (`golden/memory-tools.json`,
`golden/compaction.json`): they pass unchanged after this step. The full core suite is green.

## Files touched

`packages/core/src/memory-builtin.ts` (new), `packages/core/src/memory-router.ts` (new),
`packages/core/src/agent.ts`, `packages/core/src/sinty.ts`, `packages/core/src/__tests__/golden.test.ts`
(extra assertion that summary facts are journaled).

## Design decisions

- The builtin store stays synchronous and in-process: sqlite-vec cannot be loaded under the Node permission model,
  so it cannot be a forked plugin. Plugin providers (step 4) are async; the router bridges both.
- The router does not know about journal internals; it gets a `record()` callback (the agent's `emit`).
- `compact()` receives `toMessages` and `summarize` callbacks so the router does not import the agent and the
  speaker-specific model choice stays where the roster is known.

## Rejected alternatives

- Making `MemoryStore` itself implement the SDK provider interface: it would mix SQL with routing concerns and
  the tool output format (`date` field) that is part of the stable tool contract.
- A router per session: memory is per install/user; per-session state (recall cache) is a map inside one router.

## Migration notes

None. Same database, same prompts, same tool results.

## Known limitations

- Compaction still calls the provider through `Agent.summarize()` until step 3.

## How to test

`pnpm build && cd packages/core && node --test --test-concurrency=1 "dist/**/*.test.js"` — `golden.test.js`
must pass without `UPDATE_GOLDEN`.
