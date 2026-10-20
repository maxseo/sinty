# Cache-friendly prompt: append-only requests, frozen turn context, provider cache hints

- Date: 2026-10-20
- Area: packages/core (agent, memory router, inspect, host), packages/sdk (events, plugin, inspect, memory),
  plugins/provider-anthropic, plugins/provider-openai-compat, plugins/provider-openai-responses,
  plugins/context-inspector
- Plan step: Part 2 of the prompt-cache report (`sinty-prompt-cache-report.md`, 20.10.2026), approved by Max
  ("Делай всё: выбор агента и полную новую схему промпта с кешем"). Stacked on Part 1
  (`2026-10-20-fix-chat-agent-selection.md`).
- Commits: `feat(core): cache-friendly prompt layout with provider cache hints`

## What and why

Providers bill the unchanged start of a request as a cache hit: DeepSeek and OpenAI automatically (DeepSeek at about
a tenth of the miss price), Anthropic at `cache_control` breakpoints. The old prompt broke that prefix early on every
call:

- the system prompt (message 0) contained `Current time` and changed every minute, so with DeepSeek only the tools
  and the first part of the system prompt could ever be cached (the report measured a ~256-token ceiling for
  everything after the tools);
- the memory block, recall and processor blocks were system messages placed **before** the dialogue and rebuilt on
  every step, so any new fact or a new recall rewrote everything after them;
- once the history passed 65 % of the window, compaction re-folded on **every** turn and moved the dialogue start;
- trimming old tool results moved its boundary on every turn;
- tool order depended on which plugin finished starting first;
- `provider-anthropic` merged every system message (including context plugins' tail notes) into `system`, so the
  first block of the request changed on every step;
- `provider-openai-responses` did the same with `instructions`.

Now every request is the previous request plus new messages at the end, between the steps of a turn, between turns
and after a restart. The only exceptions are compaction (once per several turns) and the 8-turn trimming step.

## Files touched

- `packages/core/src/prompt.ts` (new): turn context helpers (`renderTurnContext`, `formatTurnTime`,
  `resolveTimezone`, `isTurnContext`, `isHumanMessage`), cache hint helpers (`hint`, `withoutHint`).
- `packages/core/src/agent.ts`:
  - `buildContext` builds `[system, skills, memory snapshot, summary?] + dialogue`, then context plugins;
    `cacheHint` `static` on the skill catalog, `session` on the last session-memory message, `turn` on the last
    dialogue message;
  - `ensureTurnContext` writes `context.turn` once per turn (time to the minute with zone, recall, memory updates,
    blocks from `beforeContext`); `eventsToMessages` replays it as a user message before the turn's first human
    message;
  - the system prompt no longer has `Current time` (only the workspace folder line);
  - tool schemas sorted by wire name; `cacheKey` = `sinty-` + first 24 hex chars of sha256(session id);
  - context contributors go through `appendOnly` (see below), with a one-time warning per plugin;
  - `lastPrompt` (only while an inspector runs) for the snapshot's `cache.reused`.
- `packages/core/src/memory-router.ts`: `sessionMessages` (frozen `memory.snapshot` + summary), `turnBlocks`
  (recall, `memory.updates`, `beforeContext` once per turn), `traceTurn`; stepped `compact`; `foldTranscript` shortens
  `context.turn` to its time.
- `packages/core/src/memory.ts`: `trimOldToolResults(messages, keepUsers = 12, step = 8)`, stepped; turn contexts and
  supervisor notices do not count as human turns.
- `packages/core/src/inspect.ts`: `appendOnly`, part kind `turn` with `blocks`, `cacheHint` on parts, `cacheInfo`
  (`hints`, `cacheable`, `reused`), `reordered` on contributor traces; hints are ignored in keys and token estimates.
- `packages/core/src/host/host.ts`: `reorder()` keeps the plugin map in `plugins.enabled` order after the parallel
  start and after a reload.
- `packages/core/src/sinty.ts`: the router gets `sessionEvents` (journal reads by type).
- `packages/sdk`: `CacheHint`, `ChatMessage.cacheHint`, `ProviderRequest.cacheKey`, `ProviderUsage`
  (`cachedTokens`, `cacheMissTokens`, `cacheWriteTokens`), events `context.turn` and `memory.snapshot`, snapshot
  `cache`, part kind `turn`, `ContextPluginTrace.reordered`; doc comments on `ctx.context` (append only) and
  `beforeContext` (once per turn, frozen).
- Providers:
  - `provider-anthropic`: `buildBody` sends `system` as text blocks, `cache_control` on hinted messages (at most 4,
    the `turn` one always kept), later system messages in place as user `<system>…</system>` text; options
    `promptCache: false`, `cacheTtl: "1h"`; `usageOf` adds cache reads and writes to `inputTokens`.
  - `provider-openai-compat`: hints stripped; `prompt_cache_key` when `options.promptCacheKey` is true, or by default
    for `api.openai.com`; `usageOf` reads DeepSeek `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` and OpenAI
    `prompt_tokens_details.cached_tokens`.
  - `provider-openai-responses`: `instructions` only from leading system messages, later ones as `developer` items;
    `prompt_cache_key` unless `options.promptCacheKey` is false; cached / missed / written input in usage.
- `plugins/context-inspector`: keeps `usage.recorded` per step (bounded with the snapshots), `/snapshots/:id`
  returns it; the page shows real vs estimated tokens, «кэш N%» per step, the cache boundary row, the row where the
  cached prefix broke, the `turn` kind with its blocks, and a warning for contributors that were `reordered`.
- Tests:
  - `packages/core/src/__tests__/prompt-cache.test.ts` (new, 6 tests);
  - `packages/core/test-fixtures/plugins/context-rewrite` (new fixture that breaks the append-only rule);
  - unit tests in the three provider plugins (`src/index.test.ts`, new `test` scripts);
  - updated: `memory.test.ts` (stepped trim), `memory-router.test.ts`, `memory-plugins.test.ts` (recall now in the
    turn context), `context-inspect.test.ts` (new layout, hints, `reused`), `golden.test.ts` (turn time normalized
    to `<TURN_TIME>`), `helpers.ts` (`types()` skips `context.turn` and `memory.snapshot`), context-inspector store
    and page tests.
- Golden prompts regenerated with `UPDATE_GOLDEN=1`: `golden/compaction.json`, `golden/memory-tools.json`. The diff
  is the layout described here: the system prompt without time, the turn context before each human message, recall
  and memory updates inside it, sorted tools, cache hints on three messages.
- Docs: `docs/spec/protocol.md` ("Prompt caching", new events), `docs/spec/memory.md` (turn lifecycle, snapshot,
  stepped compaction, `beforeContext`), `docs/spec/context-inspect.md`, provider and context-inspector READMEs,
  `CHANGELOG.md`.

## Design decisions

- **Stability zones, most stable first.** Tools → system prompt and skills → session memory (snapshot + summary) →
  dialogue → context plugins' tail. Each zone changes less often than the next one, so a change only invalidates what
  comes after it.
- **The turn context is a user message, frozen in the journal.** Time, recall and memory updates are computed on the
  turn's first step, journaled as `context.turn` and replayed byte for byte on later steps and after a restart. It is
  placed **before** the turn's first human message, wrapped in `<turn_context>` with a line saying it was not written
  by the user, so the last user message of a turn is still the human's (plugins and fixtures that read "the last
  user message" keep working). A system role would be merged or reordered by some providers; a user role is sent
  everywhere as is.
- **Time to the minute, with the zone.** `2026-10-20 16:09, Tuesday (Europe/Moscow, UTC+03:00)`. The zone is
  `agent.timezone`, else the process zone, else UTC. Minutes are enough and the value never changes within a turn.
- **Memory snapshot per session.** The memory block is frozen in `memory.snapshot` (reason `start`, `compaction`,
  `agent`). New facts reach the model once, in the next turn's `<memory_updates>`. Refreshing at compaction is free:
  compaction already breaks the prefix.
- **`beforeContext` once per turn.** It used to run on every step over all memory blocks; now it runs once on the
  turn context blocks and the result is frozen. This is a contract change for processors (documented in the SDK and
  `memory.md`); no bundled plugin implements `beforeContext`.
- **Stepped compaction and trimming.** Compaction keeps the existing summary and everything after `coversUntil` while
  that fits under 65 % of the window, and only then folds again to the last 12 user turns. Old tool results are
  shortened at a boundary that moves once every 8 human turns.
- **Append-only context plugins, salvaged rather than rejected.** `appendOnly` keeps the input as it was and keeps
  only what the contributor added after the last input message; insertions and edits before that are ignored, with
  one warning per plugin and `reordered` in the snapshot. Rejecting the plugin entirely would silently drop useful
  tail notes; letting it edit would break the cache on every call.
- **Hints in the core, wire format in plugins.** The core only says where stable zones end (`cacheHint`) and gives a
  per-chat `cacheKey`; each provider plugin decides what to do with them. Everything stays a plugin, the core hook is
  two optional fields.
- **Hint marks the last message of a zone.** That is where an Anthropic breakpoint belongs. With more than 4 hinted
  messages the Anthropic plugin keeps the turn breakpoint and the last 3 head ones.
- **`prompt_cache_key` opt-in for openai-compat.** Some OpenAI-compatible servers reject unknown fields, so it is sent
  by default only to `api.openai.com`. DeepSeek does not need it (its cache is keyed by prefix).
- **Deterministic tools.** Sorted by wire name, and the host keeps plugins in configured order after a parallel start
  or reload, so two processes with the same config send the same tool list.

## Deviations from the report

- **Usage fields.** The report proposed `cacheReadTokens` next to `cachedTokens`. `cachedTokens` already meant "read
  from cache" in the SDK and the Web UI, so it stays the read count; only `cacheMissTokens` and `cacheWriteTokens`
  were added. `inputTokens` is always the whole prompt (for Anthropic: input + cache reads + cache writes).
- **Turn context role.** The report placed the per-turn block as a system message right before the user message. It
  is a user message before the human's message, for the reason above.
- **Context plugins that rewrite.** The report said "may only append"; the core enforces it by keeping the appended
  part instead of failing the plugin.
- **Compaction was also stepped.** Not in the report: the code re-folded on every turn after the first fold, which
  would have broken the prefix on every turn of a long chat.
- **Plugin order in the host.** Not in the report: the tool list order depended on plugin start-up timing.
- **Measurement in tests, not live.** The live check against DeepSeek with Max's key was not run from the box; the
  numbers below come from the context snapshots' `cache.reused` (estimates) and the wire tests. The **Контекст** tab
  now shows the provider's real numbers per step.

## Expected effect

Measured on the box with the context snapshots (10 turns × 3 model steps, recall on, a memory write per turn, a
context plugin tail note, 1960 tokens of tool schemas): 94 % of the estimated prompt tokens of all steps repeat the
previous request's prefix (148 733 of 158 154). The share grows with longer chats and larger tool lists; the first
step of a chat and the step after a compaction are full misses. With DeepSeek pricing (hit ≈ 1/10 of a miss) that is
about −85 % on input cost, in line with the report's 82–94 % cacheable / −86 % estimate. Before, according to the report, the
cacheable prefix stopped at the time line of the system prompt (~256 tokens after the tools) whenever the minute
changed, and at the memory blocks on every step that recalled or wrote something.

## Rejected alternatives

- **Time in the system prompt rounded to the hour or day.** Still breaks the whole prefix once per hour/day, and the
  agent loses minute precision.
- **Recall as a tool only.** Would remove automatic recall, which users rely on; freezing it per turn keeps it.
- **Rebuilding the memory block on every turn but placing it at the end.** The model would see it move and repeat;
  the snapshot + updates approach sends each fact once.
- **Anthropic automatic caching only on the last message.** One breakpoint misses the system/tools zone when the
  dialogue gets longer than the 20-block lookback.

## Migration notes

- Old sessions have no `memory.snapshot` and no `context.turn` for past turns: the next step writes the snapshot, and
  past turns are replayed without a turn context (as before, minus the time). Nothing to migrate.
- Processors with `beforeContext` now see only the turn blocks once per turn. A processor that edited the memory
  profile block must move that logic to `onWrite` or to its own provider.
- Context plugins that edit earlier messages lose those edits (warning in the log, `reordered` in snapshots).
- Golden prompts changed (see above).

## Known limitations

- A forgotten fact stays in the session's memory snapshot until the next compaction; the `memory.forget` result tells
  the model in the same turn.
- When the compaction summary fails, the prompt is trimmed to the last 12 user turns on every turn (degraded mode,
  journaled), which breaks the prefix each turn until a summary succeeds.
- `cache.reused` in snapshots compares with the previous step in the same process only; after a restart the first
  step has no comparison.
- Live DeepSeek / Anthropic hit rates are not verified in CI; the wire tests use local servers.

## How to test

- `pnpm -r --workspace-concurrency=1 run build && pnpm -r run test`.
- `packages/core`: `node --test --test-concurrency=1 dist/__tests__/prompt-cache.test.js` (prefix stability,
  restart, compaction, append-only, plugin order, openai-compat and Anthropic wire bodies and usage).
- Provider plugins: `pnpm --filter provider-anthropic test` (and the two OpenAI ones).
- Manually: enable `context-inspector`, open **Контекст** in a chat with DeepSeek: «кэш N%» per step should be high
  from the second step on; a red row appears only when an earlier message changed.
