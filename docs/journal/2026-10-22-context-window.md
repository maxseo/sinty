# Context window per model: provider lists, a sourced table, real-token calibration and a ring in the Контекст tab

- Date: 2026-10-22
- Area: packages/sdk (plugin.ts, models.ts, inspect.ts, events.ts), packages/core (context-window.ts, agent, memory-router, config, host, runner, protocol, sinty, api/server), packages/cli (doctor), plugins/provider-openai-compat, plugins/provider-openai-responses, plugins/provider-anthropic, plugins/context-inspector, docs
- Plan step: queue after step 7 (`/workspace/sinty-memory-plan.md` section 12: "окно контекста + кольцо во вкладке Контекст")
- Commits: `feat(context): per-model context window for compaction, ring in the Контекст tab`

## What and why

Compaction folded the dialogue at 65% of `memory.contextTokens`, a single number with a default of 128000 that
nothing set. Max talks to DeepSeek V4.1 Flash (1M window), so the dialogue was folded at ~83k estimated tokens, an
eighth of what the model takes (journal 2026-10-21, "memory snapshot": the only knob). `ProviderDefinition.listModels`
already had a `contextWindow` field, but the core never called it and no provider filled it.

Now the window is resolved per route, compaction uses the chat model's window, the estimate is corrected by what the
provider really counted, and the Контекст tab shows the window, how full the prompt is and where the fold happens.

## Files touched

- **SDK** `plugin.ts`: `ModelInfo { id, contextWindow?, maxOutputTokens? }`, `listModels()` returns it (documented as
  the most input tokens). `models.ts`: `openAIModelList(body)` reads `GET /models` answers of OpenAI-compatible
  servers: `max_input_tokens`, `context_length` (OpenRouter, Together), `top_provider.context_length`,
  `context_window` (Groq), `max_model_len` (vLLM), `max_context_length` (Mistral); output from
  `max_completion_tokens` / `top_provider.max_completion_tokens` / `max_output_tokens`. `inspect.ts`:
  `ContextWindowInfo`, `ContextSnapshot.window?`. `events.ts`: `model.request.estTokens?`.
- **Host** `protocol.ts`: `ready.listers?`, `provider.list` / `provider.listed`. `runner.ts`: answers `provider.list`
  with only `id` and positive integer windows. `host.ts`: `PluginProcess.listers`, `listModelsProvider()` (15 s),
  `PluginHost.listerFor()`.
- **Core** `context-window.ts` (new): `ContextWindows.resolve(route)`, `refresh(providerId)`, `warm()`, `reset()`;
  `KNOWN_CONTEXT_WINDOWS`, `knownContextWindow()`; `tokenRatio()`, `ratioFromEvents()`; `FALLBACK_CONTEXT_WINDOW`,
  `COMPACT_AT`. `config.ts`: `memory.contextTokens: "auto" | number` (default `auto`), `models.contextWindows`
  (`"provider/model": tokens`, optional). `memory-router.ts`: `CompactInput.window` and `tokenRatio`; the limits
  are the window divided by the ratio. `agent.ts`: `contextWindow(sessionId)`, `estTokens` on `model.request`, the
  per-session ratio (memory, filled from the journal on first use), `window` in snapshots. `sinty.ts`:
  `Sinty.windows`, `warm()` on start. `api/server.ts`: `GET /v1/models` adds `contextWindow` per catalog route;
  `PUT /v1/models` stores only `route` and `enabled` and calls `windows.reset()`.
- **Providers**: openai-compat and openai-responses `listModels()` use `openAIModelList` and pass `endpoint.headers`;
  provider-anthropic gets `listModels()` (`GET /v1/models?limit=1000`, `max_input_tokens`, `max_tokens`).
- **CLI** `doctor`: an `info context window <route>: N tokens (source), summary at M` line.
- **context-inspector** `page.ts`: a first card with an SVG ring (fill, fold tick), the window number, its source,
  `факт`/`оценка` with the ratio and the fold threshold; `fmt` prints millions as `1M`.
- **Tests**: `packages/core/src/__tests__/context-window.test.ts` (7 tests), `page.test.ts` (ring),
  provider tests for both list parsers; fixture `recording-provider` gets `options.models` (`listModels`) and
  `options.inputScale` (usage = estimate × scale). The local HTTP servers in `m3`, `models` and `prompt-cache` tests
  answer `GET` with an empty list, because the core now asks `GET /models` once on start.
- **Docs**: `docs/spec/memory.md` (Context window), `context-inspect.md` (`window?`), `protocol.md` (`/v1/models`).

## Design decisions

- **Order:** `memory.contextTokens` number → `models.contextWindows[route]` → provider list → table → 128000. A
  number stays the manual override for every model, as before; `auto` is the new default. The per-route map is for
  local servers and models no list or table knows.
- **The provider reports, the core decides.** Windows come from the provider plugins (they know their API); the core
  only calls `listModels()` over the new `provider.list` message, the same request/answer pattern as
  `provider.embed`. No provider-specific code in the core.
- **Never wait for the network in a turn.** `resolve()` is synchronous. A miss starts a background `refresh`; the
  result is cached in `data/context-windows.json` (24 h, invalidated by a changed `baseUrl`) so after a restart the
  first turn already has it. A provider is asked at most once per process (also when it fails), `reset()` after the
  model settings change. The first turn after a fresh install may use the table or 128000.
- **The table holds only published numbers, with the URL.** DeepSeek `deepseek-flash`, `deepseek-v4-pro`,
  `deepseek-v4-flash` (legacy alias): 1,000,000 (api-docs.deepseek.com/quick_start/pricing, checked 2026-10-22;
  "1M" is literal, it may be 1,048,576). OpenAI `gpt-4.1` 1,047,576, `gpt-4o` 128,000, `gpt-5` 272,000 (the
  input limit; the 400,000 window includes output). Exact id or `<id>-YYYY-MM-DD`; `gpt-4o-mini` is not guessed.
  Claude needs no rows: the Models API reports `max_input_tokens`.
- **Calibration instead of a tokenizer.** chars/4 undercounts Cyrillic by about a third. The provider's
  `usage.inputTokens` (the whole prompt for every bundled provider) divided by the core's estimate of the same request
  (`estTokens`, messages + tool schemas) gives a per-chat ratio; the compaction limits are divided by it. Ratios
  outside 0.5–3 are ignored: test providers report constants, some providers report nothing. The ratio of the
  previous step is used, so it lags one step.
- **Prompt cache (PR #6) is untouched.** No prompt text changes: the window only moves when a fold happens. The fold
  still happens only at the start of a turn and stays stepped. `estTokens` is journal data, not prompt data. The
  existing prompt-cache and golden tests pass unchanged.
- **The ring shows the whole prompt, the tick the fold threshold.** The fold is measured on the dialogue only, so the
  fill can pass the tick slightly before a fold (system prompt and tools are not counted toward it); the tooltip says
  so. The fill uses the real `inputTokens` once the step finished, else the estimate × ratio.

## Rejected alternatives

- A tokenizer per model (tiktoken, DeepSeek's): heavy dependencies, still wrong for unknown models; the provider's own
  count is exact and free.
- Using the smallest window of all fallback routes: safer when a small fallback takes over, but would hold the main
  model to the fallback's window all the time. The primary route decides; see limitations.
- Asking the list on every turn or blocking start on it: a slow `/models` would delay every turn.

## Migration notes

- A config without `memory.contextTokens` now gets the model's window. For Max's DeepSeek route that is 1,000,000
  instead of 128,000: the dialogue is folded at ~650k real tokens instead of ~83k estimated. Long chats send much
  bigger prompts (mostly cache hits on DeepSeek, but not free). To keep the old behaviour: `memory.contextTokens: 128000`.
- A config with a number keeps it. Old journals have no `estTokens`: the ratio starts after the first new step.

## Known limitations

- The window of the first route is used; a fallback with a smaller window can be overflowed after a fallback switch.
- DeepSeek and OpenAI lists carry no windows; models missing from the table fall back to 128000 until
  `models.contextWindows` is set (doctor says so).
- The ratio lags one step and is per chat, not per model; a chat that switches agents mid-way uses the last ratio.
- Anthropic's list is one page of up to 1000 models (no pagination needed today).

## How to test

- `corepack pnpm -r run test` (also with `TZ=UTC`); the new tests are in `context-window.test.ts`.
- `sinty doctor` prints the window of `models.default`.
- Контекст tab: the first card shows the ring; screenshot of a rendered sample: `/workspace/context-window-ring.png`.
