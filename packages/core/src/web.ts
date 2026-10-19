import { mkdirSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { ulid } from "./ids.js";

const MAX_CHARS = 20_000;
const MAX_BYTES = 1_500_000;

export interface PageDoc {
  url: string;
  title: string;
  markdown: string;
  links: { text: string; url: string }[];
  untrusted: true;
}

export function assertPublicHttp(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("url is not valid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("only http and https");
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("local hosts are blocked");
  if (isIP(host) && isPrivateAddress(host)) throw new Error("private addresses are blocked");
  return parsed;
}

export async function assertPublicResolved(url: string): Promise<URL> {
  const parsed = assertPublicHttp(url);
  if (isIP(parsed.hostname)) return parsed;
  const records = await lookup(parsed.hostname, { all: true });
  if (records.some((r) => isPrivateAddress(r.address))) throw new Error("host resolves to a private address");
  return parsed;
}

export function htmlToMarkdown(html: string, base: string): { title: string; markdown: string; links: { text: string; url: string }[] } {
  const title = decode(match(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? "").trim();
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  const links: { text: string; url: string }[] = [];
  const withLinks = body.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_all, href: string, text: string) => {
    const url = resolveHref(base, href);
    const label = strip(text);
    if (url && label) links.push({ text: label, url });
    return url ? `[${label || url}](${url})` : label;
  });
  let md = withLinks
    .replace(/<h1[^>]*>/gi, "\n# ")
    .replace(/<h2[^>]*>/gi, "\n## ")
    .replace(/<h3[^>]*>/gi, "\n### ")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|article|tr|br|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  md = decode(md).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (md.length > MAX_CHARS) md = `${md.slice(0, MAX_CHARS)}\n…[truncated]`;
  const seen = new Set<string>();
  const unique = links.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true))).slice(0, 40);
  return { title, markdown: md, links: unique };
}

export async function readPage(url: string): Promise<PageDoc> {
  const finalUrl = await fetchPublic(url);
  const html = finalUrl.body;
  const doc = htmlToMarkdown(html, finalUrl.url);
  return { url: finalUrl.url, ...doc, untrusted: true };
}

export async function searchWeb(query: string): Promise<{ query: string; results: { title: string; url: string; snippet: string }[]; untrusted: true }> {
  const q = query.trim();
  if (!q) throw new Error("query is empty");
  const fetched = await fetchPublic(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
  const results: { title: string; url: string; snippet: string }[] = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fetched.body)) && results.length < 8) {
    const url = unwrapDuck(decode(m[1] ?? ""));
    if (!url) continue;
    results.push({ title: strip(m[2] ?? ""), url, snippet: strip(m[3] ?? "") });
  }
  return { query: q, results, untrusted: true };
}

export async function shotPage(workspace: string, url: string): Promise<{ url: string; path: string; title: string }> {
  const page = await withBrowser(url, async (p) => {
    const title = await p.title();
    const dir = join(workspace, "browser");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${ulid()}.png`);
    await p.screenshot({ path, fullPage: false });
    return { url: p.url(), path, title };
  });
  return page;
}

export async function interactPage(
  workspace: string,
  url: string,
  actions: { type: "click" | "type" | "press" | "goto"; selector?: string; text?: string }[],
): Promise<PageDoc & { screenshot: string }> {
  if (actions.length > 8) throw new Error("at most 8 actions");
  return withBrowser(url, async (p) => {
    for (const a of actions) {
      if (a.type === "goto") {
        if (!a.text) throw new Error("goto needs text with a url");
        await assertPublicResolved(a.text);
        await p.goto(a.text, { waitUntil: "domcontentloaded", timeout: 20_000 });
      } else if (a.type === "click") {
        if (!a.selector) throw new Error("click needs a selector");
        await p.click(a.selector, { timeout: 8_000 });
      } else if (a.type === "type") {
        if (!a.selector) throw new Error("type needs a selector");
        await p.fill(a.selector, a.text ?? "");
      } else {
        await p.keyboard.press(a.text || "Enter");
      }
    }
    const html = await p.content();
    const doc = htmlToMarkdown(html, p.url());
    const dir = join(workspace, "browser");
    mkdirSync(dir, { recursive: true });
    const screenshot = join(dir, `${ulid()}.png`);
    await p.screenshot({ path: screenshot, fullPage: false });
    return { url: p.url(), ...doc, untrusted: true as const, screenshot };
  });
}

async function fetchPublic(url: string): Promise<{ url: string; body: string }> {
  let current = (await assertPublicResolved(url)).toString();
  for (let i = 0; i < 5; i++) {
    const res = await fetch(current, { redirect: "manual", headers: { "user-agent": "Sinty/1.0" }, signal: AbortSignal.timeout(20_000) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("redirect without location");
      current = (await assertPublicResolved(new URL(loc, current).toString())).toString();
      continue;
    }
    if (!res.ok) throw new Error(`page returned ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error("page is larger than 1.5 MB");
    return { url: current, body: buf.toString("utf8") };
  }
  throw new Error("too many redirects");
}

async function withBrowser<T>(url: string, run: (page: BrowserPage) => Promise<T>): Promise<T> {
  await assertPublicResolved(url);
  let playwright: { chromium: { launch: (opts: { headless: boolean }) => Promise<BrowserApp> } };
  try {
    playwright = (await import("playwright")) as typeof playwright;
  } catch {
    throw new Error("playwright is not installed. In the Sinty app folder run: npx playwright install chromium");
  }
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    return await run(page);
  } finally {
    await browser.close();
  }
}

interface BrowserPage {
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  goto(url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  click(selector: string, opts: { timeout: number }): Promise<unknown>;
  fill(selector: string, text: string): Promise<unknown>;
  keyboard: { press(key: string): Promise<unknown> };
  screenshot(opts: { path: string; fullPage: boolean }): Promise<unknown>;
}
interface BrowserApp {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

function isPrivateAddress(address: string): boolean {
  const v4 = address.includes(".") ? address.split(".").map((n) => Number(n)) : [];
  if (v4.length === 4 && v4.every((n) => n >= 0 && n <= 255)) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  const lower = address.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

function unwrapDuck(href: string): string | undefined {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    const target = uddg ? decodeURIComponent(uddg) : url.toString();
    assertPublicHttp(target);
    return target;
  } catch {
    return undefined;
  }
}

function resolveHref(base: string, href: string): string | undefined {
  if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) return undefined;
  try {
    const url = new URL(href, base).toString();
    assertPublicHttp(url);
    return url;
  } catch {
    return undefined;
  }
}

function match(html: string, re: RegExp): string | undefined {
  return re.exec(html)?.[1];
}

function strip(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
