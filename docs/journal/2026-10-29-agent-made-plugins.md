# The agent writes new plugins

Follows [Plugin rights](2026-10-29-plugin-rights.md). Rules: [plugin-rules.md](../spec/plugin-rules.md) section 9.

## What changed

- Core tool `plugin.create` `{ plugin, reason, files }` stages a new plugin, checks its manifest against the rules for agent-written plugins and runs the load check and `*.test.*` files in the sandbox. Policy default `allow`: nothing runs yet.
- `plugin.apply_patch` for a plugin that does not exist yet always asks a human, also under an allow-all policy. After approval the core copies it to `$SINTY_HOME/plugins/<name>`, commits it, adds it to `config.yaml` `plugins.enabled` and to the speaking agent's card, starts it and watches it as a canary.
- `$SINTY_HOME/plugins/.agent-made.json` lists these plugins. `findPlugin` sets `agentMade` from it. The list is outside every plugin folder, and plugins may not write under `$SINTY_HOME/plugins`, so neither a patch nor the plugin can drop the mark.
- `agent-plugins.ts` holds the rules. Manifest: only `node`, kinds `tool`/`ui`/`schedule`/`event`, fs only `$DATA` (read also `$PLUGIN`), no `shell`, `browser`, `env`, `context`, `sessions.write`, `ui.static`, `builtin`, `editable: false`, tools named `<plugin>.*` without `defaultPolicy: "allow"`. Runtime: no foreign tool names, no model providers, no public route except the GET page of a tab. The host checks both on every start; the pipeline checks the manifest on create and on every later patch.
- An agent-made plugin without `permissions.agent: ["sessions.read"]` gets no journal reads and no events.

## Why

The agent could fix plugins but not add a tool it lacked. Every plugin process already runs under the Node permission model with only its manifest rights, so a new plugin can be safe if the agent cannot ask for the rights that leave that model (`shell`, `browser`), read the host environment, inject itself into prompts or other sessions, or open unauthenticated endpoints, and if a human approves its first start.

## Test

`packages/core/src/__tests__/agent-made-plugins.test.ts`: the rule list; a scripted turn that creates a plugin, needs approval under allow-all, then calls its tool; a later patch adding `shell` is refused; existing names, `env` and a public route are refused at create. Golden snapshots `memory-tools.json` and `compaction.json` changed only by the new tool name and one sentence in the system prompt.

## Not in this change

A UI to review agent-made plugins as a list. The agent cannot widen such a plugin beyond the rules; a human edits the folder by hand.
