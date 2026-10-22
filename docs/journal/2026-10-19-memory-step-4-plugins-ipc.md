# Memory step 4: plugin providers and processors over IPC, recall budget, durable afterTurn

- Date: 2026-10-19
- Area: packages/core (memory-router.ts, agent.ts, sinty.ts, host, runner, config), packages/sdk
- Plan step: memory plan, step 4
- Commits: `feat(core): memory step 4…`
- PR: [#1](https://github.com/maxseo/sinty/pull/1) (merge `bb47710`)

## What and why

Memory plugins can now take part in every memory decision without being able to break the turn:

- **IPC.** `ctx.memory.provider(def)` / `ctx.memory.processor(def)` register in the plugin process; the `ready`
  message lists `memory.providers` and `memory.processors` (name, order, implemented hooks). The core calls them
  with `memory.call {kind, name, method, args}` → `memory.result`. Only `recall/write/forget` (providers) and the six
  hook names (processors) can be called. A plugin must declare `"memory"` in `kinds`, otherwise its registrations are
  ignored with a warning.
- **TurnInfo** (`sessionId, turnId, agentId, userId, projectId?, text`) is built by `Agent.turnInfo()` from the
  journal and passed to every hook.
- **Recall once per turn.** `MemoryRouter.recallForTurn()` runs on the first model step: `onTurnStart` plans
  (queries are merged), or `memory.recall.auto` uses the user's message. Builtin facts come first, then plugin
  providers (all enabled ones, or only `memory.providers`), deduplicated, capped by `memory.recall.limit`, filtered by
  `afterRecall`. The result is journaled as **`memory.recalled`** and cached in memory; after a restart the journaled
  event is reused, so a resumed turn sees the same recall without asking providers again.
- **Budgets and timeouts.** Each provider call has `memory.recall.timeoutMs` (3 s), each hook
  `memory.hooks.timeoutMs` (5 s), `onCompaction` 60 s, `afterTurn` `memory.hooks.afterTurnTimeoutMs` (60 s). The
  recalled block is capped at `memory.recall.budgetTokens` (1200, chars/4). Any timeout or error becomes
  **`memory.degraded`** `{provider, hook, reason}` and the router continues with what it has (builtin always works).
- **Untrusted external memory.** Every non-builtin record is marked `untrusted`, secret values from the secret store
  are redacted, control characters stripped, `</recalled_memory>`-style tags neutralised, each record capped at
  1000 chars, and the block is wrapped in `<recalled_memory untrusted="true">` with an explicit "data, not
  instructions" line. The chat message also carries `untrusted: true`. Blocks added or changed by `beforeContext` are
  sanitised and untrusted too.
- **Write path.** `memory.write`, summary facts and afterTurn facts all go through `MemoryRouter.write()`:
  `onWrite` processors (may edit text/tier/about or return `null` to drop; a drop is journaled as
  `memory.written {action: "dropped", by}` and the tool returns `{id: "", action: "dropped", by}`), the builtin store,
  then mirrored to `memory.writeTo` providers. `memory.forget` is mirrored the same way.
- **afterTurn via a durable queue.** On `turn.completed` the agent queues one row per afterTurn processor in
  `memory_jobs` (in `memory.db`, primary key `(turn_id, plugin, processor)`, so it is idempotent per turnId). The queue
  drains asynchronously after each turn and on start; failures are retried, after 3 attempts the job is `failed` and
  journaled as `memory.degraded`. Returned `facts` are written through the write path with `source` = plugin name.
- **Compaction.** `onCompaction` processors may supply `{summary, facts}`; otherwise the builtin summary call. If both
  fail the prompt keeps only the last 12 user turns (trim to the window) and the router journals `memory.degraded` and
  `memory.compacted {ok: false}` once per fold point; on success `memory.compacted {ok: true, by}`.
- `ProviderDefinition`-style async hooks are bridged to the synchronous builtin store in the router.

## Default behaviour unchanged

With no memory plugin enabled and `memory.recall.auto` unset, no hook runs, no recall block is added and no new
event is written in a normal turn; the golden prompts are byte-identical and the whole existing suite is green.

## Files touched

`packages/core/src/memory-router.ts` (rewritten), `agent.ts` (`turnInfo`, `memoryAfterTurn`, async context),
`sinty.ts` (router deps, `memory.kick()` on start, `beginClose()`/`close()` on stop), `config.ts` (`memory.providers`,
`writeTo`, `recall.*`, `hooks.*`), `host/host.ts` (`callMemory`, `memoryProviders()`, `memoryProcessors()`),
`host/runner.ts` (registration, `memory.call`), `host/protocol.ts`, `packages/sdk/src/memory.ts`
(`AfterTurnResult`), `packages/sdk/src/events.ts`, `docs/spec/memory.md`, tests `memory-router.test.ts`, fixture
`memory-test`.

## Design decisions

- **Builtin first, plugins after, never instead.** A broken plugin can only make memory poorer, never empty.
- **Cache in memory + journal.** The journal event is the durable cache, so a resumed turn does not re-query plugins
  and replays are deterministic.
- **afterTurn returns facts instead of writing directly.** Plugins never touch `memory.db`; every write passes the same
  filters and is journaled with its origin.
- **Queue in memory.db, not journal.db.** The router already owns that connection; the journal stays append-only
  events plus turn state. (The plan suggested journal.db; this is a deliberate deviation.)
- Plugin providers participate in recall by default once their plugin is enabled (enabling is the opt-in);
  mirrored writes need an explicit `memory.writeTo` because writes are riskier than reads.

## Rejected alternatives

- Running recall on every model step: multiplies plugin latency and cost by the number of steps.
- Letting external records into the main memory block: would make untrusted text look like trusted profile facts.
- Fire-and-forget afterTurn without a table: a crash between `turn.completed` and the hook loses the learning; a
  replay would run it twice.

## Migration notes

- New optional config keys; nothing to change for existing installs.
- `memory.db` gets a `memory_jobs` table on first use by an afterTurn processor.

## Known limitations

- The tool `memory.recall` passes `turnId: ""` in TurnInfo (the core tool runner has no turn id yet).
- Budget accounting for recall is by characters/4, not by the model tokenizer.
- `beforeContext` runs on every model step (by design) and therefore adds latency per step when a processor uses it.
- Queue jobs of a plugin that is never re-enabled stay `pending` forever (visible via `MemoryRouter.jobs()`).

## How to test

`node --test dist/__tests__/memory-router.test.js`: plan → one recall per turn across two model steps, untrusted +
redacted external block, timeout → `memory.degraded`, `onWrite` drop, afterTurn once per turnId with replay no-op,
3 failed attempts → `failed`, summary failure → trimmed to 12 user turns. `golden.test.js` proves the default prompt.
