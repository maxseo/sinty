# Plugin token budget survives restarts

- Date: 2026-10-20
- Area: packages/core (models.ts, journal.ts, sinty.ts)
- Plan step: follow-up to memory plan step 3 (ModelGateway); known limitation "plugin token budget resets on restart"
- Commits: `feat(models): keep plugin token usage per UTC day in journal.db`
- PR: [#3](https://github.com/maxseo/sinty/pull/3) (merge `6d65de2`)

## What and why

`ModelGateway.pluginCall()` enforces `models.pluginTokensPerDay` (default 200 000 input+output tokens per plugin per
UTC day). It kept the count in a `Map` inside the process. Any restart reset the budget: `sinty run` starts a new
process every time, and a crash-looping plugin restarts too. So for one-shot use the budget did not exist.

Now usage is stored in `journal.db`:

```sql
CREATE TABLE plugin_model_usage (plugin TEXT NOT NULL, day TEXT NOT NULL, tokens INTEGER NOT NULL, PRIMARY KEY (plugin, day));
```

`Journal.pluginModelUsage(plugin, day)` reads it. `Journal.addPluginModelUsage(plugin, day, tokens)` upserts it and
deletes rows older than 30 days. `ModelGateway` takes an optional `usage: PluginUsageStore` (`get`, `add`); `Sinty`
passes the journal-backed store. Without one, for example a gateway built directly in a unit test, an in-memory
store keeps the old behaviour.

## Files touched

- `packages/core/src/journal.ts`: table and two methods.
- `packages/core/src/models.ts`:
  - `PluginUsageStore` interface and the in-memory fallback `MemoryUsage`;
  - `GatewayDeps.usage`;
  - `pluginCall` reads and adds through the store.
- `packages/core/src/sinty.ts`: wires the journal into the gateway.
- `packages/core/src/__tests__/models.test.ts`: test `ctx.models: the plugin token budget survives a restart`.
  - Each call costs 15 tokens and the limit is 40.
  - Two calls, then a restart.
  - The third call is allowed (30 < 40); the fourth fails with `models_budget` (45 ≥ 40).

## Design decisions

- `journal.db`, not `memory.db` or the plugin's `$DATA`. The journal is core-owned (`coreOwnedPaths`), so no plugin
  permission can reach it, and a patched plugin cannot reset its own budget.
- A dedicated table instead of summing `models.called` events at start. `events` has no index on `type`, and calls
  without a `sessionId` are only logged, not journaled.
- The check is the same as before: refuse when today's usage has already reached the limit. One call can still go
  past the limit by its own size.

## Rejected alternatives

Not recorded when the change was made (noted in the 2026-10-22 docs audit, [#19](https://github.com/maxseo/sinty/pull/19)).

## Migration notes

The table is created on start (`CREATE TABLE IF NOT EXISTS`). Usage from before the upgrade is not counted.

## Known limitations

- Two Sinty processes on one home share the table but read and write without a transaction around
  check + call + add. Concurrent calls can overshoot by one call each.
- The day is UTC, as before.

## How to test

- `node --test packages/core/dist/__tests__/models.test.js`.
- SQL: `SELECT * FROM plugin_model_usage ORDER BY day DESC;` in `journal.db`.
