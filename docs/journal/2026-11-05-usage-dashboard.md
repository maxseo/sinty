# Settings → Расход

- Date: 2026-11-05
- Area: `plugins/usage`, `apps/web` (`supervisor-ui.tsx`, `plugin-tab.tsx`), `packages/core` (`DEFAULT_ON_PLUGINS`)
- Plan step: Max asked for a spend screen switchable by time, tasks, and calls
- Commits: this commit
- PR: (open with this branch, stacked on `feat/stop-shell`)

## What and why

Settings had no place to see how many tokens a day of chats had spent. The journal already writes `usage.recorded` on every model step (and on `ctx.models` when the caller passes a session). The screen belongs in a plugin: a settings section titled **Расход**, and a sandboxed page that draws the charts.

## Files touched

- `plugins/usage` — manifest, SQLite index, fold of journal events, query, tab page, routes under `/p/usage`.
- `apps/web/src/supervisor-ui.tsx` — `plugin.usage` renders that tab, same hook as RunningHub. The generic settings form would otherwise be the only UI, and it cannot draw charts.
- `apps/web/src/plugin-tab.tsx` — a theme toggle while the iframe is open is forwarded as `{ op: "theme" }`. `init.theme` is unchanged.
- `packages/core/src/config.ts` — `usage` in `DEFAULT_ON_PLUGINS`, so an existing `config.yaml` is not rewritten and the section shows up after install.
- `registry/plugins.json`, `plugins/README.md`, `README.md`, `README.ru.md`, `CHANGELOG.md`.

## Design decisions

- **Read the journal, do not add a core usage table.** `usage.recorded` already has provider, model, input/output, cache fields, and `costUsd` when a provider sends it. `model.request` supplies the route and the start time; `model.response` supplies `stopReason`; `models.called` supplies duration for plugin calls. The plugin copies that into its own SQLite file so the charts do not rescan every session on each filter change.
- **No invented dollars.** Nothing in config or the model catalog is a price. The cost card stays an em dash until some row has `costUsd`.
- **Backfill is capped and idempotent.** `listSessions` allows 500 sessions. Rows are upserted by event id, so a live event that arrives during the scan is not counted twice, and a second pass can fill a duration that the first pass missed. The cursor only moves forward. Live `ctx.on` keeps the index current after that.
- **Timezone.** The page sends `Date#getTimezoneOffset`. Buckets are hour (about a day), day (up to 120 days), or week. A chart longer than 96 buckets keeps the newest ones.
- **Tasks are sessions.** A background `agent.task` session has `metadata.taskId` and is badged «задача». Individual model calls are the third view.

## Rejected alternatives

- A core pane that queries `journal.db` directly. The data is already an event stream; a plugin can subscribe and read sessions. A new core report API would be a second writer of the same facts.
- Estimating USD from a hardcoded DeepSeek/OpenAI price table. Prices change and most routes are not those two. The spec already says a dollar budget is not offered because providers do not report `costUsd`.
- Subscribing to `model.delta` for time-to-first-token. Deltas are stream-only and are not forwarded to plugins. Wall time of the whole call is what the journal can support.

## Migration notes

No config rewrite. `plugins.config.usage.retainDays` defaults to `0` (keep the index). Set a positive number of days to drop old index rows; the session journal is untouched.

## Known limitations

- Sessions that have not been updated recently, past the newest 500, are not backfilled until a new event arrives on them.
- Plugin model calls with no `sessionId` are only logged, never journaled, so they are absent.
- Cache miss is derived as `input − cached` when the provider sent a hit and not a miss. When it sent neither, the chart shows one «Вход» segment and does not pretend there was a cache.
- Time to first token, routing overhead, and the API key name are not stored. The table shows duration, speed (output tokens per second), stop reason, and provider.
- Staff roles created before this plugin do not see the section until the right is granted. The machine token does.

## How to test

- `pnpm --filter @sinty/plugin-usage test`
- `packages/core` `usage-settings.test.ts` (section title **Расход**, tab `placement: settings`) and the default-on list in `tool-web.test.ts`.
- Manual: Settings → Расход. Empty state before any chat. After a turn, requests and tokens match the journal's `usage.recorded`. Toggle theme; the iframe follows. Switch По времени / По задачам / По вызовам. A provider that does not send `costUsd` leaves the cost card as «—».
