# MCP settings UI (phase 2): Settings → MCP

- Date: 2026-10-24
- Area: `plugins/mcp-catalog`, `apps/web` (`mcp-pane.tsx`, `supervisor-ui.tsx`), `packages/core` (`DEFAULT_ON_PLUGINS`)
- Plan step: Max approved phase 2 — own Settings section **MCP** with tabs Установленные | Добавить
- Commits: this commit
- PR: (open with this branch)

## Why

Phase 1 (`mcp.install` / `POST /v1/plugins/mcp`) lets the agent and API create home MCP plugins. Humans still had no Settings screen — only the agent card MCP tab (per-agent visibility) and Плагины (all plugins).

## Design

- **Plugin `mcp-catalog`** (bundled, `DEFAULT_ON`): owns Settings section title **MCP** via manifest `settings` (one field `showDisabled`). No install logic in the plugin — install stays core.
- **Web `McpPane`**: special-cased in `SectionPane` for `plugin.mcp-catalog` (same pattern as a custom Skills pane). Tabs:
  - **Установленные** — filter `/v1/plugins` to `mcp-stdio` | `http`; status; enable/disable via `PUT /v1/settings`.
  - **Добавить** — form → confirm → `POST /v1/plugins/mcp` (authenticated UI path from phase 1). Env values must be `secret://…`. Agent-driven install still uses policy **ask** on the `mcp.install` tool.
- Out of scope: curated catalog (phase 4), skill auto-install (phase 3), OAuth, per-agent auto-bind (agent MCP tab already exists).

## Retest

- Plugin unit: `plugins/mcp-catalog` settings reader.
- Core: `mcp-catalog-settings.test.ts` (section listed); `tool-web` DEFAULT_ON list updated for `mcp-catalog`.
- Manual on PC: Settings → MCP → Добавить → confirm → see card on Установленные; agent MCP tab for visibility.
