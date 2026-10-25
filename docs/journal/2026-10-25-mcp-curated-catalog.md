# MCP curated catalog (phase 4)

- Date: 2026-10-25
- Area: `plugins/mcp-catalog` (`catalog.ts`), `apps/web` (`mcp-pane.tsx`, `mcp-curated.ts`)
- Plan step: MCP п.4 — one-click curated cards (Max-confirmed list)
- Commits: this commit
- PR: (open with this branch)
- Base: `main` (bf9b49e). Does **not** depend on #31 (skill/auto-bind).

## Why

Phase 2 gave Settings → MCP with Установленные | Добавить. Humans still had to know npx package names and env vars. Max asked for a curated catalog under his stack.

## Design

- Third tab **Каталог** with cards. **Использовать** prefills the Добавить form (command/url + `secret://` env hints); user confirms install via existing `POST /v1/plugins/mcp`.
- Curated set (only): GitHub, PostgreSQL, MySQL, Supabase, SQLite, Filesystem, Telegram, MAX.
- Explicitly excluded: Fetch/Playwright/Brave (core web tools), Slack, Google Calendar, Memory MCP.

## Packages

| Card | Package / command | Secrets |
|------|-------------------|---------|
| GitHub | `npx -y @modelcontextprotocol/server-github` | `GITHUB_PERSONAL_ACCESS_TOKEN=secret://github.token` |
| PostgreSQL | `npx -y @zeddotdev/postgres-context-server` | `DATABASE_URL=secret://postgres.url` (Zed fork; not vulnerable archived server-postgres) |
| MySQL | `npx -y @berthojoris/mcp-mysql-server <uri> list,read,utility` | URI in command (secret:// cannot cover argv password — noted in card) |
| Supabase | `npx -y @supabase/mcp-server-supabase@latest --read-only` | `SUPABASE_ACCESS_TOKEN=secret://supabase.token` |
| SQLite | `npx -y mcp-server-sqlite --db ./data.db` | path in command |
| Filesystem | `npx -y @modelcontextprotocol/server-filesystem .` | allow-list path in command |
| Telegram | `npx -y @node2flow/telegram-bot-mcp` | `TELEGRAM_BOT_TOKEN=secret://telegram.bot` |
| MAX | `npx -y @woyax/mcp-max-messenger` | `MAX_TOKEN=secret://max.token` |

## Filesystem UI split

Max asked for a convenient **file browser in the harness UI** for VPS work. This PR ships the **Filesystem MCP card** (agent tools). A visual Settings file browser needs a list API / UI plugin and is documented as follow-up; core `fs.*` already project-chroots.

## Retest

- `plugins/mcp-catalog`: `npm test` (catalog shape + packages)
- `apps/web`: `tsc -p apps/web` + `vite build`
- Manual: Settings → MCP → Каталог → Использовать → Установить (with secrets created)
