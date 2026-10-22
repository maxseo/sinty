# Context window per model: provider lists, a sourced table, real-token calibration and a ring in the Контекст tab

- Date: 2026-10-22
- Area: packages/sdk (plugin.ts, models.ts, inspect.ts, events.ts), packages/core (context-window.ts, agent, memory-router, config, host, runner, protocol, sinty, api/server), packages/cli (doctor), plugins/provider-openai-compat, plugins/provider-openai-responses, plugins/provider-anthropic, plugins/context-inspector, docs
- Plan step: queue after step 7 ([plan](../plan.md) section 5: "окно контекста + кольцо во вкладке Контекст")
- Commits: `feat(context): per-model context window for compaction, ring in the Контекст tab`
- PR: [#14](https://github.com/maxseo/sinty/pull/14) (merge `a9218fd`)

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
  instead of 128,000: the dialogue is folded at 150k real tokens (the cap, see the follow-up) instead of ~83k
  estimated. Long chats send much
  bigger prompts (mostly cache hits on DeepSeek, but not free). To keep the old behaviour: `memory.contextTokens: 128000`.
- A config with a number keeps it. Old journals have no `estTokens`: the ratio starts after the first new step.

## Known limitations

- The window of the first route is used for compaction. A fallback with a smaller window is handled per request (see
  the follow-up below), but a fallback that is much smaller than the primary can still be skipped.
- DeepSeek and OpenAI lists carry no windows; models missing from the table fall back to 128000 until
  `models.contextWindows` is set (doctor says so).
- The ratio lags one step and is per chat, not per model; a chat that switches agents mid-way uses the last ratio.
- Anthropic's list is one page of up to 1000 models (no pagination needed today).

## How to test

- `corepack pnpm -r run test` (also with `TZ=UTC`); the new tests are in `context-window.test.ts`.
- `sinty doctor` prints the window of `models.default`.
- Контекст tab: the first card shows the ring; a rendered sample was checked by hand (screenshot not committed).

## Follow-up (2026-10-22): compaction cap and the fallback window check

Approved by Max after the first review of PR #14 (variant 1 of the cap discussion).

### What and why

- **Cap.** With a 1M window the dialogue was folded only at 650k tokens: every step sent up to 650k tokens (cache hits
  are cheaper, not free, and long prompts are slower and dilute attention). Compaction now triggers at
  min(65% of the window, `memory.compactCapTokens`), default 150000; `0` or `null` turns the cap off.
- **Fallback window.** The prompt is sized for the primary route. A fallback with a smaller window (a local 32k
  model behind DeepSeek 1M) got a prompt it cannot take and failed with a provider error. Now the core checks the
  fallback's window right before trying it.

### Files touched

- `packages/core/src/context-window.ts`: `DEFAULT_COMPACT_CAP`, `compactCap(config)`, `compactPoint(window, cap)`
  (`{ tokens, by: "window" | "cap" }`).
- `packages/core/src/config.ts`: `memory.compactCapTokens` (non-negative integer or null, optional).
- `packages/core/src/memory-router.ts`: the fold limit is the compaction point.
- `packages/core/src/agent.ts`: the snapshot's `window.compactBy`; `fitWindow()` in the routes loop of `callModel`.
- `packages/core/src/settings-sections.ts`, `packages/core/src/api/server.ts`: core section **Память и контекст**
  (`memory`), applied live.
- `packages/sdk/src/events.ts`: `model.fallback.window?`, `need?`; `model.request.trimmedForWindow?`.
  `packages/sdk/src/inspect.ts`: `ContextWindowInfo.compactBy?`.
- `plugins/context-inspector/src/page.ts`: the ring's mark is labelled «65% окна» or «потолок N».
- Tests: `packages/core/src/__tests__/context-window-cap.test.ts` (new), `context-window.test.ts`,
  `plugins/context-inspector/src/page.test.ts`; fixture `recording-provider` got `options.fail`.
- Docs: `docs/spec/memory.md`, `docs/spec/context-inspect.md`.

### Design decisions

- The cap is in real (provider) tokens like the window, and divided by the chat's ratio the same way, so the ring,
  the snapshot and compaction agree. It only lowers the point: a cap above 65% of the window changes nothing, and the
  snapshot then says `compactBy: "window"`.
- The fallback check runs only for routes after the first. The primary request, its messages, hash and cache
  layout are exactly as before (the cache tests are unchanged and green).
- Fit = `ceil(estimate × ratio) + models.maxOutputTokens <= window`. The ratio is the chat's, from the primary model;
  it is the best number available before the fallback answered once.
- The trim reuses `trimOldToolResults(messages, 2, 1)`: tool results before the last 2 human messages shrink to 15
  lines. It is applied to a copy for that one request; nothing is journaled as history, so the next primary request
  carries the full output again. `model.request` gets `trimmedForWindow: true` and the hash of what was sent; the
  usage ratio of that step uses the trimmed estimate.
- Still too big: the route is skipped with `model.fallback { from, to, reason: "window_too_small", window, need }`
  before the next one; as the last route, the turn fails with `window_too_small` and a message naming the sizes.
- A route whose window is unknown (source `fallback`, 128000 is a guess) is trimmed when needed but never skipped:
  skipping a working model on a guess would be worse than letting the provider decide.

### Rejected alternatives

- A fixed cap without a setting: different budgets and models need different numbers.
- Re-compacting (a summary call) for the fallback: an extra model call while the primary is down, and it would
  rewrite the stored summary for every later primary request.
- Trimming more aggressively (dropping old turns) for the fallback: it changes what the model knows; tool output
  trimming is the cheap, already-accepted loss.

### Migration notes

- Without `memory.compactCapTokens` the cap is 150000. For 128k–200k windows nothing changes (65% is lower). For
  DeepSeek 1M the dialogue is now folded at 150k instead of 650k. To restore 650k: `memory.compactCapTokens: 0`.

### How to test

- `context-window-cap.test.ts`: the compaction point, a 1M window folding at a small cap and not without it, the
  Settings section with live apply and the snapshot's `compactBy`, a fallback that gets a trimmed request (primary
  request and later history untouched), a fallback skipped with `window_too_small`, and the last route failing the
  turn. All five end-to-end tests fail on the previous commit (a044b36).
