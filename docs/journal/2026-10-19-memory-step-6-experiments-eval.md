# Memory step 6: memory experiments and `sinty memory eval`

- Date: 2026-10-19
- Area: packages/core (memory-router.ts, memory-eval.ts, config.ts, sinty.ts), packages/cli
- Plan step: memory plan, step 6
- Commits: `feat: memory step 6…`

## What and why

Memory changes (auto recall, limits, which providers) need evidence, not taste. Two tools:

1. **`memory.experiments`** in config: a list of experiments, each with weighted arms (`recall.{auto,limit,budgetTokens}`,
   `providers`) and optional `shadow` arms.
   - Assignment: `sha256("<experiment>:<sessionId>")` → [0,1) → cumulative weights (`assignArms`). Stable for the life
     of a session, no state to store. Weight 0 = never live (useful for shadow-only arms).
   - The live arm's overrides apply to the turn; `TurnInfo.arm` is `"<experiment>=<arm>"` (comma-joined for several
     experiments) so processors can see it.
   - Journaled once per turn: `memory.experiment {experiment, arm, shadow?}`, and the live recall's `memory.recalled`
     carries `arm`.
   - **Shadow mode:** for every shadow arm the router also runs that arm's recall in the same turn and journals it as
     `memory.recalled {arm, shadow: true}`; it never reaches the prompt. Comparing live vs shadow records offline needs no
     model calls and no user-visible change.
2. **`sinty memory eval [--labels file.jsonl] [--arms a,b] [--limit 200] [--json]`** — offline replay:
   starts plugins only (`Sinty.start({ background: false })`: no supervisor, no resumed turns, no queue), replays labeled
   queries (`{"query": "...", "expect": ["substring", ...]}`) or the last N stored `message.user` texts, for the
   `baseline` arm and every configured arm, with recall forced on. Reports per arm: hit rate on labeled queries
   (hit = any expected substring in any recalled record), mean memory-block tokens (profile block + recalled blocks),
   mean recalled tokens, mean records, p50/p95 recall latency. Nothing is written to the journal (`runPlan(..., journal=false)`).

## Files touched

`packages/core/src/config.ts` (`memory.experiments`), `memory-router.ts` (`assignArms`, `armOverrides`, `choices()`,
`experiment()`, shadow runs, `runPlan` journal flag), `memory-eval.ts` (new: `evalMemory`, `formatEval`),
`sinty.ts` (`start({ background })`), `index.ts` (exports), `packages/cli/src/bin.ts` (`memory eval`),
tests `memory-experiments.test.ts`; docs: `docs/backlog.md`, `docs/architecture.md`, `docs/spec/memory.md`.

## Design decisions

- Hash assignment instead of stored assignment: deterministic, reproducible in eval, survives restarts.
- Shadow runs are awaited inside the turn (simple and deterministic); they cost recall latency, not model tokens.
- Eval forces recall on for every arm: the question it answers is "what would this arm recall", even for arms that turn
  automatic recall off live.
- Eval reuses the router's `plan()` and `runPlan()`, so processors' `onTurnStart` / `afterRecall` are part of what is
  measured.

## Rejected alternatives

- Random assignment per turn: mixes arms inside one conversation and makes comparisons noisy.
- Running the chat model in eval: expensive and nondeterministic; recall quality is measurable without it.
- A separate experiments service: not needed for one install; the journal already stores everything.

## Migration notes

None; `memory.experiments` is optional. Experiment events appear only when it is configured.

## Known limitations

- Arms can override recall settings and providers only, not processors or compaction.
- Eval queries from the journal have no labels, so only tokens/latency are meaningful without `--labels`.
- Eval uses `config.agent.name` as the persona and an empty chat, so agent- and chat-scoped facts of other personas are
  not visible to it.
- Shadow runs add their latency to the turn's first model step.

## How to test

`node --test dist/__tests__/memory-experiments.test.js`: stable weighted assignment, live overrides + journaled arm +
shadow journaled but not shown, eval hit rate/tokens/records per arm with nothing journaled, and the CLI JSON output.
Manually: `sinty memory eval --labels labels.jsonl`.
