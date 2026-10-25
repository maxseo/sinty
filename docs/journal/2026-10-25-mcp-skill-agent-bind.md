# MCP skill + agent bind (phase 3)

- Date: 2026-10-25
- Area: `packages/core` (`mcp-install.ts`, `coretools`, `agent`), `skills/mcp-install`, docs
- Plan step: Max — nearest backlog item MCP п.3 (skill + auto-enable after п.1 install + п.2 Settings UI)
- Commits: this commit
- PR: (open with this branch)

## Why

After `mcp.install` / Settings → MCP, a newly installed MCP was harness-enabled but still invisible to an agent with an explicit `plugins` list until someone flipped the agent MCP tab. Phase 3 closes that: the agent installs on request (ask), and the runtime binds the plugin to the speaker (or sharedPlugins).

## Design

- **Skill** `skills/mcp-install/SKILL.md` — when to call `mcp.install`, secrets as `secret://`, default bind=agent, `shared` / `none` overrides. Shipped in the repo like `background-tasks`; copy into `$SINTY_HOME/skills/` on reinstall (`sinty skills add` or manual).
- **Core bind** on `installMcpPlugin`: `bind: agent | shared | none` + optional `agentId`. Agent tool defaults to `agent` and fills `agentId` from the speaking roster agent. API / Settings keep `none`.
- Binding rules (visibility only; config enable already happened):
  - `agent` + explicit `plugins` → append name
  - `agent` + empty list + non-null `sharedPlugins` → specialize agent to `[...shared, name]` (does not push onto every card)
  - `agent` + empty + shared null → already forAll (`bound.mode: all`)
  - `shared` → append to `sharedPlugins` (or `all` when shared is null)
- Result includes `bound` + updated `next` hint.

## Out of scope

- Curated one-click catalog (п.4)
- OAuth MCP flows
- Reinstall / copy skill onto KOMPUTER home (manual after merge)

## Retest

- `packages/core`: `mcp-install.test.ts` — bind=agent / shared / none; tool path ask→approve→ping with speaker bind.
- Manual after merge: chat «установи MCP …», approve, confirm tools without opening agent MCP tab; optional `sinty skills add skills/mcp-install`.
