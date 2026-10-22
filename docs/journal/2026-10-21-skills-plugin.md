# Skills move out of the core into the `skills` plugin; `ctx.systemSection` for stable prompt blocks

- Date: 2026-10-21
- Area: packages/sdk (plugin.ts), packages/core (agent, host, runner, protocol, coretools, config, inspect, api/server), plugins/skills, apps/web (agent card), registry, docs
- Plan step: 7, part 2 ([plan](../plan.md) section 4, from the original plan's section 10: "Скилы — перенести в плагин `skills`")
- Commits: `feat(skills): move skills into a default-on plugin, ctx.systemSection for the catalog`
- PR: [#11](https://github.com/maxseo/sinty/pull/11) (merge `0986d8f`)

## What and why

Skills were core code: `packages/core/src/skills.ts` (folder scan, frontmatter description, safe paths), six core
tools in `coretools.ts` (`skill.read`, `skill.files`, `skill.read_file`, `skill.write_file`, `skill.edit`,
`skill.write`) handled in `Agent.runCoreTool`, and the catalog that `Agent.buildContext` put at prompt index 1 with
the `static` cache hint. The plan's principle is "everything as plugins, minimal hooks in the core", and
`tool-web` (PR #8) showed the pattern. This change moves all of it into `plugins/skills`, on by default, and adds the
one hook the catalog needs.

The catalog cannot be an ordinary context contributor: since PR #6 context plugins may only append at the tail, and
the catalog belongs to the static zone, right after the system prompt, so the provider's prompt cache keeps it. Hence
a new, narrow hook.

## Files touched

- **SDK** `packages/sdk/src/plugin.ts`: `ctx.systemSection(name, render, { order?, kind? })`,
  `SystemSectionInput { sessionId, agent?: { id, name, skills } }`, `SystemSectionContributor`,
  `SystemSectionOptions`.
- **Host:** `host/protocol.ts` (`SectionInfo`, `ready.sections?`, `section.run` / `section.result` /
  `section.error`), `host/runner.ts` (registration, run), `host/host.ts` (`PluginProcess.sections`,
  `runSection()` with a 5 s timeout, `PluginHost.sections()` sorted by order, `plugins.enabled` order, name).
- **Agent** `agent.ts`: the skills import and the skill branch of `runCoreTool` are gone. `buildContext` builds
  `[system prompt, ...system sections, ...memory]`, `static` on the last system block; new
  `systemSections(sessionId, speaker)` filters by `agentHasPlugin` (default-on and `excludedPlugins` semantics of
  PR #9) and keeps the last good text per session and section (`lastSections`, capped at 500 entries).
- **Core tools** `coretools.ts`: the six skill definitions removed; `RESERVED_TOOL_PREFIXES` gains
  `"skill.": "skills"`.
- **Config** `config.ts`: `DEFAULT_ON_PLUGINS = ["tool-web", "skills"]`.
- **Inspector labels** `inspect.ts`: `traceBase(trace, messages, sections, memoryCount, turnBlocks)`; sections take
  their own labels (`kind` from the section, `source` = plugin, `id` = `<plugin>/<section>`).
- **API** `api/server.ts`: `GET /v1/roster/skills` stays as a compatibility alias that forwards to the plugin's
  `GET /p/skills/list`; with the plugin off it answers `{ skills: [], disabled: true }`.
- **Plugin** `plugins/skills/`: `sinty.plugin.json` (kinds `tool`, `context`; `fs` read/write `$SKILLS`; six tools
  with `docs: README.md`; `config.catalogLimit` 60; Settings section «Навыки»; `editable: true`), `src/skills.ts`
  (moved with history from the core, unchanged), `src/index.ts`, `src/settings.ts`, `README.md` with one `## skill.*`
  section per tool for the supervisor, tests `src/skills.test.ts` (moved) and `src/settings.test.ts`.
- **Web UI** `apps/web/src/pages.tsx`: the agent card's Навыки tab says when the plugin is off, or excluded on that card.
- **Tests:** `packages/core/src/__tests__/skills-plugin.test.ts` (8 tests), fixtures `skill-squatter`,
  `section-flaky`; `context-inspect.test.ts` checks the catalog's new source and id; `tool-web.test.ts` updated for the
  second default-on plugin.
- **Docs:** `docs/spec/protocol.md` (prompt caching table, system sections), `docs/spec/plugin-manifest.md`,
  `docs/spec/context-inspect.md`, `docs/architecture.md`, `plugins/README.md`, `registry/plugins.json`, CHANGELOG.

## Design decisions

- **Byte-identical prompt.** The plugin renders the catalog with the same `skillCatalog()` and the same default limit
  (60), filtered the same way (a roster agent sees its ticked `skills`, the global persona sees all). The golden and
  prompt-cache tests pass unchanged, and a new test compares message 1 with the old text literally. Hints are the
  same: none on the system prompt, `static` on the catalog. An install that upgrades keeps its cache prefix.
- **A generic hook, not a skills hook.** `ctx.systemSection` knows nothing about skills. It gets the speaking agent's
  card fields (`id`, `name`, `skills`); `skills` stays a core field of the agent card (roster.json, edited in the UI).
  `kind: "skills"` only changes the inspector label, so the context inspector keeps its «навыки» colour.
- **Stable on failure.** A section is in the cached prefix; dropping it on one failed IPC call would break the cache for
  the whole session. So a failed or slow (5 s) section repeats the session's last good text; with no earlier text it
  is left out and a warning is logged.
- **Rendered every step, as before.** The core re-read the skills folder on every model step, so `skill.write` shows up
  in the next step's catalog (the tool description promises that). The section keeps that; the cost is one IPC
  round trip per step.
- **Visibility follows the agent card.** Sections of a plugin the card excludes are not rendered, matching the tool
  filter (`pluginVisible`). `plugins.disabled: [skills]` removes the plugin entirely; then the system prompt carries
  the `static` hint itself.
- **Names kept and reserved.** Same names, descriptions, zod schemas (compared as JSON Schema), side effects,
  idempotency, error codes (`not_found`, `invalid_args`) and hints, so `policy.yaml` `"skill.*": allow`, approvals,
  `agent.task`'s default `skill.read`, the supervisor and old journals keep working. `skill.` is reserved for the
  bundled plugin like `web.`.
- **No config migration.** No skills keys existed in config.yaml. Old `plugins.enabled` lists without `skills` get it
  from `DEFAULT_ON_PLUGINS` in memory; nothing is rewritten.

## Rejected alternatives

- **Catalog as a context contributor.** Would put it after the dialogue (append-only), outside the static zone, and
  change every prompt.
- **Let context contributors insert at index 1.** Undoes PR #6's guarantee for every plugin.
- **Catalog inside the system prompt text.** Mixes plugin text into the core's prompt and breaks the old layout.
- **Drop `/v1/roster/skills`.** It is a public API; keeping a forwarder costs a few lines.

## Migration notes

- Upgrading needs nothing. The plugin is staged with the other bundled plugins and turns on by itself.
- To turn skills off: Settings → Плагины → untick `skills` (writes `plugins.disabled`), or per agent on its card.
- Context snapshots taken before this change label the catalog `source: core`, `id: skills`; new ones say
  `source: skills`, `id: skills/catalog`.

## Known limitations

- Plugin tool calls differ from core calls in small, general ways: an argument error comes from the runner with
  the hint "Fix the arguments to match the tool input schema." (the core said "… tool schema."), plugin errors carry
  `retryable: false` in the journal, and a plugin crash during `skill.edit` (non-idempotent, no `recover`) is treated
  like any plugin tool crash.
- `catalogLimit` is read at plugin start (Settings says so); changing it changes the catalog and starts the cache
  once more.
- `skills` remains a field of the core agent card; the plugin reads it from `SystemSectionInput.agent`.

## How to test

- `corepack pnpm -r --workspace-concurrency=1 run build && corepack pnpm -r run test` (also with `TZ=UTC`).
- `packages/core/src/__tests__/skills-plugin.test.ts`: ownership and schema parity, catalog text and hints,
  per-agent skills, `excludedPlugins`, `plugins.disabled`, `/v1/roster/skills` and `/p/skills/list`, a failing
  section, the reserved prefix, inspector labels. Run against main 150f018, 8 of its 9 tests (and the changed
  context-inspect test) fail; the catalog-parity test passes on both, as it should.
