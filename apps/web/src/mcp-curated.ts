/** Curated one-click MCP entries for Settings → MCP → Каталог (phase 4). */

export type CuratedRuntime = "mcp-stdio" | "http";

export interface CuratedMcp {
  /** Suggested plugin id (POST /v1/plugins/mcp `name`). */
  id: string;
  /** Short UI title. */
  title: string;
  /** One-line description in the card. */
  summary: string;
  runtime: CuratedRuntime;
  /** mcp-stdio argv (executable first). */
  command?: string[];
  /** http MCP endpoint. */
  url?: string;
  /**
   * Env for the MCP child. Values are `secret://…` hints — user must create the secrets first.
   * Never raw tokens.
   */
  envHints?: Record<string, string>;
  /** Extra help under the card (URI-in-command limits, etc.). */
  note?: string;
  /** Optional docs link shown in the card. */
  docsUrl?: string;
}

/**
 * Max-confirmed set (2026-10-25). Excludes Fetch/Playwright/Brave/Slack/Calendar —
 * web tools already live in Sinty core. Memory MCP included so Max can try the KG layer (per-agent toggle).
 */
export const CURATED_MCP: readonly CuratedMcp[] = [
  {
    id: "github",
    title: "GitHub",
    summary: "Репозитории, issues, PR и файлы через GitHub API.",
    runtime: "mcp-stdio",
    command: ["npx", "-y", "@modelcontextprotocol/server-github"],
    envHints: { GITHUB_PERSONAL_ACCESS_TOKEN: "secret://github.token" },
    note: "Создайте secret://github.token (PAT). Upstream reference; official follow-on is github/github-mcp-server.",
    docsUrl: "https://www.npmjs.com/package/@modelcontextprotocol/server-github",
  },
  {
    id: "postgres",
    title: "PostgreSQL",
    summary: "Схема и SQL к Postgres (Zed fork с патчем read-only).",
    runtime: "mcp-stdio",
    command: ["npx", "-y", "@zeddotdev/postgres-context-server"],
    envHints: { DATABASE_URL: "secret://postgres.url" },
    note: "В secret://postgres.url положите полный postgresql://… URI. Не используем устаревший @modelcontextprotocol/server-postgres (SQL injection).",
    docsUrl: "https://www.npmjs.com/package/@zeddotdev/postgres-context-server",
  },
  {
    id: "mysql",
    title: "MySQL",
    summary: "Список/чтение MySQL (list,read,utility).",
    runtime: "mcp-stdio",
    command: [
      "npx",
      "-y",
      "@berthojoris/mcp-mysql-server",
      "mysql://USER:PASS@localhost:3306/db",
      "list,read,utility",
    ],
    note: "Замените URI в command перед установкой. Пароль в argv нельзя провести через secret:// — для продакшена лучше отдельный read-only пользователь без спецсимволов или кастомный MCP с env.",
    docsUrl: "https://www.npmjs.com/package/@berthojoris/mcp-mysql-server",
  },
  {
    id: "supabase",
    title: "Supabase",
    summary: "Проекты Supabase: SQL, ветки, edge functions (stdio + PAT).",
    runtime: "mcp-stdio",
    command: ["npx", "-y", "@supabase/mcp-server-supabase@latest", "--read-only"],
    envHints: { SUPABASE_ACCESS_TOKEN: "secret://supabase.token" },
    note: "PAT из Supabase Dashboard → Access Tokens. Опционально добавьте --project-ref <ref> в command. Hosted HTTP mcp.supabase.com нужен OAuth — для Sinty удобнее stdio + PAT.",
    docsUrl: "https://supabase.com/docs/guides/ai-tools/mcp",
  },
  {
    id: "sqlite",
    title: "SQLite",
    summary: "Локальный .db: схема, query/execute.",
    runtime: "mcp-stdio",
    command: ["npx", "-y", "mcp-server-sqlite", "--db", "./data.db"],
    note: "Поправьте --db на путь к файлу (часто внутри workspace/projects/<slug>).",
    docsUrl: "https://www.npmjs.com/package/mcp-server-sqlite",
  },
  {
    id: "filesystem",
    title: "Filesystem",
    summary: "MCP-доступ к каталогу на диске (list/read/write) — для агента на VPS.",
    runtime: "mcp-stdio",
    command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
    note:
      "Замените «.» на абсолютный allow-list каталог (например workspace проекта). Это MCP для агента, не визуальный браузер в UI. Визуальный файловый браузер в харнесе — отдельный follow-up (нужен list API / UI-плагин); core fs.* уже chroot'ит в project workspace.",
    docsUrl: "https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem",
  },
  {
    id: "telegram",
    title: "Telegram",
    summary: "Bot API: сообщения, чаты, файлы (27 tools).",
    runtime: "mcp-stdio",
    command: ["npx", "-y", "@node2flow/telegram-bot-mcp"],
    envHints: { TELEGRAM_BOT_TOKEN: "secret://telegram.bot" },
    note: "Токен от @BotFather → secret://telegram.bot.",
    docsUrl: "https://www.npmjs.com/package/@node2flow/telegram-bot-mcp",
  },
  {
    id: "max-messenger",
    title: "MAX",
    summary: "Мессенджер MAX (VK): сообщения, чаты, медиа, кнопки.",
    runtime: "mcp-stdio",
    command: ["npx", "-y", "@woyax/mcp-max-messenger"],
    envHints: { MAX_TOKEN: "secret://max.token" },
    note: "Токен бота MAX → secret://max.token. Пакет @woyax/mcp-max-messenger (реальный npm, не выдуман).",
    docsUrl: "https://www.npmjs.com/package/@woyax/mcp-max-messenger",
  },
  {
    id: "memory",
    title: "Memory",
    summary: "Knowledge-graph memory (сущности + связи) — отдельный слой рядом с встроенной memory Sinty.",
    runtime: "mcp-stdio",
    command: ["npx", "-y", "@modelcontextprotocol/server-memory"],
    note: "Официальный @modelcontextprotocol/server-memory. Опционально задайте MEMORY_FILE_PATH абсолютным путём к .jsonl (не secret:// — это путь, не токен). Вкл/выкл на агенте — вкладка MCP. Max хочет попробовать поверх ядра.",
    docsUrl: "https://www.npmjs.com/package/@modelcontextprotocol/server-memory",
  },] as const;

export function curatedById(id: string): CuratedMcp | undefined {
  return CURATED_MCP.find((c) => c.id === id);
}

/** Build a POST /v1/plugins/mcp body from a curated card (secrets still secret://). */
export function curatedInstallBody(
  entry: CuratedMcp,
  opts?: { replace?: boolean; description?: string },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: entry.id,
    runtime: entry.runtime,
    description: opts?.description?.trim() || entry.summary,
    ...(opts?.replace ? { replace: true } : {}),
  };
  if (entry.envHints && Object.keys(entry.envHints).length) {
    body.env = { ...entry.envHints };
  }
  if (entry.runtime === "mcp-stdio") {
    if (!entry.command?.length) throw new Error(`curated ${entry.id}: mcp-stdio needs command`);
    body.command = [...entry.command];
  } else {
    if (!entry.url) throw new Error(`curated ${entry.id}: http needs url`);
    body.url = entry.url;
  }
  return body;
}
