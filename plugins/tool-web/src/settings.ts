import { isAbsolute, normalize } from "node:path";
import type { SearchEngine } from "./search.ts";

/** Plugin settings (manifest config merged with config.yaml plugins.config.tool-web), clamped to sane ranges. */
export interface WebSettings {
  searchEngine: SearchEngine;
  searxngUrl: string;
  maxResults: number;
  timeoutMs: number;
  maxBytes: number;
  maxChars: number;
  maxLinks: number;
  browserTimeoutMs: number;
  actionTimeoutMs: number;
  screenshotDir: string;
  userAgent: string;
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
    maxBytes: Math.round(num(config.maxPageKb, 1500, 50, 20_000) * 1000),
    maxChars: Math.round(num(config.maxChars, 20_000, 1000, 200_000)),
    maxLinks: Math.round(num(config.maxLinks, 40, 1, 200)),
    browserTimeoutMs: num(config.browserTimeoutSeconds, 20, 1, 60) * 1000,
    actionTimeoutMs: num(config.actionTimeoutSeconds, 8, 1, 60) * 1000,
    screenshotDir: safeSubdir(config.screenshotDir),
    userAgent: typeof config.userAgent === "string" && config.userAgent.trim() ? config.userAgent.trim().slice(0, 200) : "Sinty/1.0",
  };
}
