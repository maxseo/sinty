# Memory step 3: models through the core (`ctx.models`, ModelGateway, embeddings)

- Date: 2026-10-19
- Area: packages/core (models.ts, host, runner, agent, sinty, config), plugins/provider-openai-compat
- Plan step: memory plan, step 3
- Commits: `feat(core): memory step 3…`

## What and why

Memory plugins need models (fact extraction, embeddings) but must not hold API keys or bypass accounting.
`ModelGateway` (`packages/core/src/models.ts`) is the single place for non-turn model calls:

- **Routes.** `resolve(route)`: `default` → `models.default` + `models.fallback`; `cheap` → `models.routes.cheap`,
  else `service.model`, else `models.default`; `embed` → `models.routes.embed` (no fallback); any other
  `models.routes` key; or an explicit `provider/model`.
- **Secrets.** The gateway resolves `providers.<id>.apiKey` from the secret store; plugins never see it.
- **complete()** streams through the provider plugin of the route's protocol and tries candidates in order.
- **embed()** calls the new optional `ProviderDefinition.embed()` through the new `provider.embed` IPC message;
  `provider-openai-compat` implements it (`POST {baseUrl}/embeddings`, sorted by `index`, count checked).
- **pluginCall()** serves `ctx.models` from plugins: checks `permissions.models` (route names or `*`), the per-plugin
  daily budget `models.pluginTokensPerDay` (default 200 000, 0 = unlimited, in memory per UTC day), caps
  `maxOutputTokens` at `models.maxOutputTokens`, journals `models.called` and, with a `sessionId`,
  `usage.recorded` (actor = the plugin). Without a session the call is logged instead.
- The **builtin compaction summary** now also goes through `ModelGateway.complete()` with the same explicit route
  as before (speaker service model → `service.model` → speaker model → `models.default`). The request the provider
  receives is identical (golden test `compaction` unchanged).
- IPC: runner `ctx.models.complete/embed` → `models.call` → host `HostEvents.models` → gateway → `models.result`.
  Ready message carries `embedders` (protocols with `embed()`). Host also gained a generic `request()` helper with
  timeout/abort used by `embedProvider()` and `callMemory()` (the latter is used from step 4).

## Files touched

`packages/core/src/models.ts` (new), `host/host.ts`, `host/protocol.ts`, `host/runner.ts`, `agent.ts`
(`summarize()` via gateway), `sinty.ts` (`Sinty.models`), `config.ts` (`models.pluginTokensPerDay`),
`plugins/provider-openai-compat/src/index.ts` (`embed`), tests `models.test.ts`, fixtures `models-user`,
`recording-provider` (toy `embed`).

## Design decisions

- Route names instead of model ids in plugin code: the human decides in `config.yaml` what "cheap" means.
- `permissions.models` is explicit per route; `*` is required for raw `provider/model` routes so a plugin cannot
  pick an expensive model the human did not name.
- Budget is in-memory per process and UTC day: simple and enough to stop a runaway loop; durable accounting is
  the journal (`models.called`, `usage.recorded`).
- Summary calls are not journaled as `usage.recorded` yet, to keep default turns' event streams identical.

## Rejected alternatives

- Passing endpoint + key to plugins (as provider plugins get): leaks secrets into every memory plugin.
- A separate HTTP API for plugins: IPC already exists, is authenticated by construction and supports structured clone.
- Embeddings as a separate plugin kind: they belong to the provider that already knows the endpoint and auth.

## Migration notes

- Optional config: `models.routes.cheap`, `models.routes.embed`, `models.pluginTokensPerDay`.
- Provider plugin authors may add `embed()`; nothing changes if they do not.

## Known limitations

- The daily plugin budget resets on restart.
- Only `provider-openai-compat` implements `embed()`; Anthropic has no embeddings API, `openai-responses` could
  reuse the same endpoint later.
- `models.called` needs a `sessionId` to be journaled; calls without one (e.g. background indexing) are only logged.

## How to test

`node --test dist/__tests__/models.test.js` covers: complete via `cheap`, `models_denied` for a route not in the
manifest, embed via `embed`, the budget, route resolution, and `provider-openai-compat` embeddings against a local
HTTP server. `golden.test.js` proves the summary request is unchanged.
