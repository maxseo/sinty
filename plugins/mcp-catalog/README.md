# mcp-catalog

Owns **Settings → MCP**.

- **Установленные** — list/enable home & bundled MCP plugins (`mcp-stdio` / `http`)
- **Каталог** — curated one-click cards (phase 4): GitHub, PostgreSQL, MySQL, Supabase, SQLite, Filesystem, Telegram, MAX
- **Добавить** — custom install via `POST /v1/plugins/mcp` (same as `mcp.install`)

Install logic stays in core. Secrets only as secret://….

Curated data: src/catalog.ts (mirrored in pps/web/src/mcp-curated.ts for the pane).

Out of scope: OAuth. Skill mcp-install + mcp.install bind=agent|shared live in core/skills (phase 3).
