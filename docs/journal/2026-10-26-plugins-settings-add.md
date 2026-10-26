# Plugins Settings: full catalog + Add tab

- Date: 2026-10-26
- Area: `apps/web` Settings → Plugins, `packages/core` discover + plugin-install, `GET /v1/settings`, `POST /v1/plugins/install`
- Plan step: harness UX — Settings Plugins parity with MCP (Installed | Add); show opt-in-off (scheduler)
- Commits: this commit (extends PR #35)
- PR: https://github.com/maxseo/sinty/pull/35

## What and why

Settings → Plugins listed only loaded plugins (`GET /v1/plugins`) / registry-enabled extras, so opt-in-off plugins like `scheduler` never appeared and there was no Add tab. Max wants every harness plugin visible as enabled/disabled, plus an Add path for custom/local plugins (MCP stays in its own section).

## Files touched

- `packages/core/src/discover.ts` — registry + home (+ searchPaths) catalog
- `packages/core/src/plugin-install.ts` — install from path or `npm pack`
- `packages/core/src/api/server.ts` — settings uses discover; `POST /v1/plugins/install`
- `apps/web/src/pages.tsx` — Установленные | Добавить; immediate toggles
- tests, CHANGELOG

## Design decisions

- **Reuse `PUT /v1/settings` for toggles** (same as MCP pane), not a parallel config writer.
- **Install API in core** (like mcp.install): UI stays thin; house rule plugins-over-core still holds for MCP catalog, but harness plugin install is a core config/filesystem concern.
- **Home scan in discover** so disabled home MCP/custom plugins show as Выключен without being in `plugins.enabled`.

## Known limitations

- npm install needs `npm` on PATH; extract prefers `tar`, falls back to `npm install --ignore-scripts` of the packed tgz.
- Enable still needs process restart for plugins that were never loaded this run (same as before); hot-start works for path/npm install via `host.reload`.
- No curated "plugin store" catalog (only path/npm). MCP curated catalog remains under Settings → MCP.