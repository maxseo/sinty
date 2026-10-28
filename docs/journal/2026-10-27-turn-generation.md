# Turn generation on Stop

## What changed

`packages/core/src/agent.ts`. Each running turn has a generation. `interrupt` increments it before aborting the controller. `execute` captured the number before the tool ran. A result that comes back with a different number is journaled as `tool.call.failed` / `stale_turn` and the payload is not stored. The turn then ends interrupted. The turn is registered in `running` before `advance` starts, so a live call is not mistaken for a late one.

## Why

Abort already cancelled the in-flight call, but a result that won the race was stored as `tool.call.completed`. The next turn read it as a successful tool result. A file the tool already wrote is still on disk; only the answer is dropped.

## Revert

Drop `generation` from the running entry and the `stale_turn` check in `execute`.
