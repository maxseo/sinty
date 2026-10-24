# MCP install (phase 1): home plugin + core tool + API

- Date: 2026-10-24
- Area: packages/core (`mcp-install.ts`, `coretools`, `agent`, `api/server`, `mcp-stdio`), docs/spec/plugin-manifest.md
- Plan step: Max asked for MCP install starting with phase 1 (API + agent tool + tests); catalog UI / skill / per-agent auto-enable are later
- Commits: this commit
- PR: (open with this branch)

## Why

External MCP servers are already plugins (`runtime: mcp-stdio` | `http`), but nothing could *create* a new plugin folder: the patch pipeline only edits existing plugins. Humans and the agent needed a guarded way to drop a manifest under `$SINTY_HOME/plugins/<name>/`, enable it, and hot-start it.

## Design

- **Core-owned**, not a plugin: writing into `$SINTY_HOME/plugins` and `plugins.enabled` is the same class of ownership as config/policy. Tool name `mcp.install` (reserved as a core tool).
- Reuse `parseManifest` + `PluginHost.reload` — no parallel loader.
- Default policy **ask** (`sideEffects: external` + `tools["mcp.install"]: ask` in DEFAULT_POLICY_YAML).
- Secrets: names or `secret://name` only; optional `env` map values must be `secret://…` (stored in `plugins.config.<name>.env`). Raw values refused. `mcp-stdio` passes resolved secrets into the MCP child env when that map is set.
- API: `POST /v1/plugins/mcp` (authenticated) for the future catalog UI.

## Out of scope (phase 2+)

- Curated catalog UI / `mcp-catalog` plugin
- Skill «install when user asks»
- Auto-enable on a specific agent after install (result returns a `next` hint)
- OAuth MCP flows
- MCP framing rewrite

## Golden

`UPDATE_GOLDEN=1` refreshed `compaction.json` / `memory-tools.json` tool lists to include `mcp__install`.

## Retest

- Core tests: `mcp-install.test.ts` (happy path, bad name / bundled / exists, secrets, API 401, tool ask→approve).
- Manual on PC after merge/install: from a chat call `mcp.install` (or POST `/v1/plugins/mcp`) with a known stdio server; approve; confirm tools on `/v1/plugins` and MCP tab.
