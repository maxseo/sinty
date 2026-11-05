# usage

Owns **Settings → Расход**.

The screen is a dashboard: KPI cards, animated charts, and a table. Switch **По времени**, **По задачам**, or **По вызовам**. Filters are the period, model, provider, and agent.

## Enable

The plugin is on by default (`DEFAULT_ON_PLUGINS`). It appears after `sinty web` starts. To turn it off, untick `usage` under Settings → Плагины (that writes `plugins.disabled`).

A staff role sees the section only with the **Расход** settings right (`ui:usage/settings`). The chart data uses that same right. The page itself is `ui:usage/spend`.

## Where the numbers come from

Each model step is already journaled as `usage.recorded` (provider, model, input/output tokens, cache hit/miss/write when the provider sends them, `costUsd` when the provider sends it). `model.request` / `model.response` add the route, the wall time, and the stop reason. A plugin call through `ctx.models` is the same `usage.recorded` plus `models.called` (that one has the duration).

On start the plugin reads up to 500 recently updated sessions (`permissions.agent: ["sessions.read"]`) into `$SINTY_HOME/data/usage/usage.db`. Later events are appended live. The journal is not rewritten. Calls a plugin makes **without** a `sessionId` are not journaled, so they stay off this screen.

Dollars are shown only when `costUsd` is actually stored. Sinty does not keep a price list, and this plugin does not invent one. Token counts and request counts are the figures that are always there.

`plugins.config.usage.retainDays` (default `0`) deletes old rows from the plugin index only. The settings screen is the dashboard, not the form; change the number in `config.yaml`.

## HTTP

The iframe is `GET /p/usage/tab` (public, no data). The bridge calls, with the signed-in token:

| Route | Body |
|---|---|
| `GET /status` | index size, backfill state |
| `GET /summary` | request and token totals; `costUsd` is `null` when no call has a price |
| `GET /series?tz=` | buckets in the browser's timezone (`tz` is `Date#getTimezoneOffset`) |
| `GET /tasks` | one row per session; a background `agent.task` is marked `task` |
| `GET /calls` | one row per model call, newest first |
| `GET /facets` | models, providers, agents for the filters |

`from` is inclusive, `to` is exclusive, both ISO timestamps.

## Not here

Provider wallets, OpenRouter billing sync, time-to-first-token (that lives on `model.delta`, which is not journaled and not delivered to plugins), and API key names (the filter is the provider, never the secret).
