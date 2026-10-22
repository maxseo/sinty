# tool-web on agent cards, agent.task tools, one fold per turn

- Date: 2026-10-21
- Area: packages/core (agent.ts, roster.ts, memory-router.ts, api/server.ts), apps/web (agent editor, plugin list)
- Plan step: follow-up to step 7 part 1 (`2026-10-21-tool-web-plugin.md`), two regressions found on installed main 06dd3da
- Commits: `6a1fcd7 fix: tool-web on every agent card, agent.task child tools, one memory fold per turn`, `654ff47 test(prompt-cache): next-turn check no longer depends on the time zone name`
- PR: [#9](https://github.com/maxseo/sinty/pull/9) (merge `f3b5533`)

## What and why

**1. Web denied for roster agents.** In chat `ses_01M59Z72X3X772AGB7S2SSF83N` (agent `agt_331f7075`), turn
`trn_01M5EYMFD2NWZN0XC5GZD86D67`, all three `web.search` calls got `tool.call.denied` "this plugin is not on this
agent". The agent card in `roster.json` had an explicit `plugins` list (ui-web, provider-openai-compat,
provider-anthropic, tool-fs, kanban, context-inspector): the editor saves the shared defaults into the card on the
first save, and that happened before `tool-web` existed. `pluginVisible()` treated a non-empty card list as the only
plugins the agent has, so a plugin that took over former core tools vanished from every existing card. The shared
list already contained `tool-web`; it is not consulted when the card has its own list.

**1b. The agent.task child had no tools.** The child session `ses_01M5EYQJ1JTMACJMC4HZSAKMVM` was created with
`tools: [web.search, web.read, web.links, memory.recall, skill.read]`, but `callModel()` compared that list with the
schema names, which are wire names (`web_search`). Nothing matched, so the child model was offered no tools at all
(1,095 input tokens) and answered that it has no internet. This bug is older than tool-web. The child also ran as the
global persona (`memory.snapshot` agentId `Sinty`) because `speaker()` found no members in a session without project
or `agentIds`.

**2. Memory snapshot changed within a turn.** In the same turn the journal shows, before each of the three model
steps: four or five `memory.written` (source summary), `memory.compacted` with the same `coversUntil: 82`, and a new
`memory.snapshot` (`reason: compaction`; 1,341 → 1,603 → 1,662 chars). Cause: `memory.contextTokens` is 128,000, so the
fold limit is 83,200 estimated tokens; the last 12 user turns alone were ~100k (real: ~153k), so after folding the
dialogue was still over the limit, the stepped check failed, and the same head was folded again before every step.
Each fold called the summary model again, got a different wording, stored its facts again and so refreshed the
snapshot. The prompt diverged at message 2 (`memory.profile`), and DeepSeek reported `cachedTokens: 384` of ~153k on
every step: the cache was really missed, not misreported. Not the cause: the child turn (own session, own snapshot),
`memory.write` (writes never refresh the snapshot), the agent-switch rule (agentId was stable).

## Files touched

- `packages/core/src/roster.ts`: `AgentRecord.excludedPlugins`, `agentHasPlugin()`.
- `packages/core/src/agent.ts`: `pluginVisible()` uses `agentHasPlugin()` with `DEFAULT_ON_PLUGINS`; child tool list
  compared by wire name; `speaker()` of a child session is the parent's.
- `packages/core/src/memory-router.ts`: `compact()` — fold only before the first model step of a turn, never refold a
  folded head, keep fewer than 12 turns (min `MIN_KEEP_USER_TURNS = 2`) when 12 are over the limit.
- `packages/core/src/api/server.ts`: `/v1/plugins` returns `defaultOn`; default-on plugins are `forAll`.
- `apps/web/src/pages.tsx`: agent editor and Settings → Плагины handle default-on plugins.
- `packages/core/test-fixtures/plugins/recording-provider/index.js`: `options.varySummary`.
- Tests: `agent-plugins.test.ts` (new), `prompt-cache.test.ts` (repro), `memory-router.test.ts`, golden `compaction.json`.
- Docs: `docs/spec/memory.md`, `docs/spec/plugin-manifest.md`, `CHANGELOG.md`.

## Design decisions

- **Default-on plugins ignore the card's list; only an explicit exclusion removes them.** `tool-web` replaces former
  core tools that every agent had. Treating it like an optional plugin makes every card saved before the move lose
  the capability, and so would every future plugin that takes over core tools. A one-off migration that adds
  `tool-web` to cards would fix today's cards but not the next default-on plugin, and it would rewrite `roster.json`.
  A separate `excludedPlugins` field keeps "this agent goes without the web" explicit and survives saves that do not
  send it.
- The shared list ("у всех") does not apply to default-on plugins either; the button is disabled for them. Turning
  the plugin off for everyone is `plugins.disabled` (Settings → Плагины → выключен).
- **A child turn is its parent's agent.** Persona, memory scope, plugin list and exclusions come from the parent's
  speaker, so a child cannot reach tools its parent may not use, and it can use the ones the parent can. Its snapshot
  and summary stay in the child session.
- **Fold at turn start only.** A fold rewrites the start of the prompt; doing it between tool steps throws away the
  provider cache in the middle of a turn. Later steps keep what the previous step was sent and fold only if the
  estimate reaches the whole window.
- **Fold to half the limit when 12 turns do not fit.** Folding to just under the limit would fold again on the next
  turn (and break the cache every turn).

## Rejected alternatives

- Migration that writes `tool-web` into every card: one-off, rewrites user data, repeats for each future plugin.
- "Inherit defaults" flag per card: same effect as `excludedPlugins` with one more state to explain.
- Skipping compaction while the turn runs regardless of size: a long tool loop could overflow the window.

## Migration notes

No file is rewritten. Existing cards get `tool-web` back on the next start; `excludedPlugins` is empty until the
human unticks a default-on plugin in the agent editor. Chats that were folding on every step fold once more at the
next turn (to fewer kept turns) and then hold their prefix.

## Known limitations

- `estimateTokens()` counts JSON characters / 4, which undercounts Cyrillic text (~103k estimated vs ~153k real in
  this chat). `memory.contextTokens` should be set to the model's real window; it is the only knob.
- A turn that reaches the whole window mid-turn still folds mid-turn (by design: better than a provider error).

## How to test

`corepack pnpm -r test`. The regressions: `agent-plugins.test.ts` (card without tool-web gets web tools; card with
`excludedPlugins: [tool-web]` does not; child gets exactly its list and the parent's persona; API fields) and
`prompt-cache.test.ts` "folds once, not on every step" (14 long turns, then a 3-step turn with two tool calls and an
`agent.task`: on main it folds 3 times in the turn; now at most once and steps 2 and 3 only append).
