import { isAbsolute, normalize } from "node:path";
import type { SearchEngine } from "./search.ts";

/** Plugin settings (manifest config merged with config.yaml plugins.config.tool-web), clamped to sane ranges. */
export interface WebSettings {
  searchEngine: SearchEngine;
  searxngUrl: string;
  maxResults: number;
  timeoutMs: number;
  maxBytes: number;
  /** Hard download limit for web.fetch_file (no truncate). */
  maxFetchBytes: number;
  maxChars: number;
  maxLinks: number;
  browserTimeoutMs: number;
  actionTimeoutMs: number;
  screenshotDir: string;
  userAgent: string;
  acceptLanguage: string;
}

/**
 * A current desktop Chrome. Many shops and anti-bot services answer 401/403 to an unknown agent such as the old
 * default `Sinty/1.0`, so that value (saved into config.yaml by older Settings pages) also maps to this one.
 */
export const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const LEGACY_USER_AGENT = "Sinty/1.0";
export const DEFAULT_ACCEPT_LANGUAGE = "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7";
export const ACCEPT_HTML = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

function header(v: unknown, def: string, legacy?: string): string {
  const t = typeof v === "string" ? v.trim().replace(/[\r\n]+/g, " ").slice(0, 300) : "";
  return !t || t === legacy ? def : t;
}

function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

/** A folder inside the workspace; anything else falls back to "browser". */
export function safeSubdir(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) return "browser";
  const n = normalize(v.trim()).replace(/\\/g, "/").replace(/\/+$/, "");
  if (isAbsolute(n) || /^[A-Za-z]:/.test(n) || n === "." || n.split("/").some((p) => p === ".." || p === "")) return "browser";
  return n;
}

export function readSettings(config: Readonly<Record<string, unknown>>): WebSettings {
  return {
    searchEngine: config.searchEngine === "searxng" ? "searxng" : "duckduckgo",
    searxngUrl: typeof config.searxngUrl === "string" ? config.searxngUrl : "",
    maxResults: Math.round(num(config.maxResults, 8, 1, 20)),
    timeoutMs: num(config.timeoutSeconds, 20, 1, 60) * 1000,
    maxBytes: Math.round(num(config.maxPageKb, 5000, 50, 20_000) * 1000),
    maxFetchBytes: Math.round(num(config.maxFetchMb, 20, 1, 20) * 1_000_000),
    maxChars: Math.round(num(config.maxChars, 20_000, 1000, 200_000)),
    maxLinks: Math.round(num(config.maxLinks, 40, 1, 200)),
    browserTimeoutMs: num(config.browserTimeoutSeconds, 20, 1, 60) * 1000,
    actionTimeoutMs: num(config.actionTimeoutSeconds, 8, 1, 60) * 1000,
    screenshotDir: safeSubdir(config.screenshotDir),
    userAgent: header(config.userAgent, BROWSER_USER_AGENT, LEGACY_USER_AGENT),
    acceptLanguage: header(config.acceptLanguage, DEFAULT_ACCEPT_LANGUAGE),
  };
}
