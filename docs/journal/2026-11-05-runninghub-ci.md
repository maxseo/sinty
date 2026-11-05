# RunningHub tip CI (2026-11-05)

PR #85 stayed red after the FakeEl `querySelector` fix. Five core tests failed for reasons that landed with the stack tip, not with RunningHub's product code alone.

## Failures

1. **Golden prompts** (`memory-tools`, `compaction`) — DEFAULT_ON now includes `runninghub` and `tool-stt`, so the model saw `runninghub__*` and `stt__transcribe`. Regenerated with `UPDATE_GOLDEN=1`.
2. **Fallback window trim** — the tiny fallback window was sized from messages only; default-on tools inflated `estTokens` and the fallback was skipped without a `model.request`. The test now disables `DEFAULT_ON_PLUGINS` so the window math stays about tool-result trimming.
3. **`agent.task` description** — copy no longer says "background: true only"; the assertion matches "Set background: true yourself".
4. **Kanban card → review** — the board API dropped `assignee: "agent"` for roster `assigneeId`/`reviewerId`. The test seeds two agents and starts a ready todo card.

## Files

- `packages/core/src/__tests__/golden/*.json`
- `packages/core/src/__tests__/context-window-cap.test.ts`
- `packages/core/src/__tests__/policy-trust.test.ts`
- `packages/core/src/__tests__/m3.test.ts`
