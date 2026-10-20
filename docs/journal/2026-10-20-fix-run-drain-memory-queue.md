# Fix: drain the afterTurn memory queue before shutdown

- Date: 2026-10-20
- Area: packages/core (sinty.ts, memory-router.ts, agent.ts, config.ts)
- Plan step: follow-up to memory plan step 4 (durable afterTurn queue)
- Commits: `fix(core): drain the memory afterTurn queue before plugins stop`

## What and why

With `fact-extractor` enabled, `sinty run "…"` never finished the afterTurn job. The CLI calls `Sinty.stop()` right
after the turn. `stop()` called `memory.beginClose()` and `host.stop()` at once, so:

- the extractor's `ctx.models` call failed with `plugin provider-openai-compat exited with code 0`;
- a result that did arrive was written after the router closed and logged
  `fact from fact-extractor was not stored memory is closed`;
- the job stayed `pending` in `memory_jobs`.

The same race affected every caller of `stop()` (serve on Ctrl+C, tests). Only long-running `sinty web` worked,
because the queue had time to drain.

## Files touched

- `packages/core/src/memory-router.ts`
  - new `drainBeforeClose(timeoutMs)`: kicks the queue, races `idle()` against the timeout, counts the pending jobs
    of running processors and logs a warning when some are left;
  - `drain()` now drops a result that arrives after shutdown began, instead of writing into a closed store.
- `packages/core/src/sinty.ts`
  - `stop({ drainTimeoutMs? })`: after `agent.stop()`, waits on `drainBeforeClose`, then stops supervisor and plugins.
- `packages/core/src/agent.ts`
  - afterTurn is queued before `endTurn()`, so the job row exists before anyone waiting for the turn wakes up.
    The enqueue was already synchronous; this makes the order explicit.
- `packages/core/src/config.ts`
  - `memory.hooks.closeTimeoutMs`. Default: `afterTurnTimeoutMs`, capped at 15 000 ms, so Ctrl+C on `serve` is not
    held for the full 60 s.
- `docs/spec/memory.md`, `CHANGELOG.md`.
- Tests:
  - `packages/core/src/__tests__/memory-router.test.ts`: two new tests;
  - fixture `memory-test`: new option `afterTurnSlowMs`.

## Design decisions

- The drain lives in `Sinty.stop()`, not in the CLI, so every caller benefits.
- The wait is one overall budget, not a budget per job.
- Jobs whose plugin is not running are not counted and not waited for. They already wait for a later start.
- Jobs that run out of time are not marked `failed` and their attempts are not counted. They stay `pending` and run
  again on the next start (`kick()` in `start()`), exactly as after a crash.

## Rejected alternatives

- Waiting only in `sinty run`: other callers (serve, embedders, tests) would keep the race.
- Waiting with `afterTurnTimeoutMs` (60 s) on every shutdown: too long for Ctrl+C.

## Known limitations

- A job abandoned at the timeout runs again on the next start. If its model call had already succeeded, the model
  is called twice. Writes are deduplicated by hash.

## How to test

- `pnpm --filter @sinty/core test`. The new tests:
  - `router: stop() drains the afterTurn queue…` — one turn, `stop()` without `memory.idle()`, then `memory_jobs` is
    `done` and the fact is stored;
  - `router: stop() gives up waiting after the close timeout…` — 5 s job, `drainTimeoutMs: 200`, a warning, the job
    stays `pending`, and it is `done` after the next start.
- Manual: enable `fact-extractor` with a `cheap` route, run `sinty run "…"`, then
  `SELECT status FROM memory_jobs` shows `done`, and there is no `memory is closed` warning.
