import { decode, isShownUrl, strip } from "./page.ts";

/**
 * Search result parsers. DuckDuckGo changes its HTML now and then; when web.search stops finding results, this file
 * is the one to patch (plugin.propose_patch) together with search.test.ts.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchEngine = "duckduckgo" | "searxng";

/** The page to fetch for a query. */
export function searchUrl(engine: SearchEngine, query: string, searxngUrl = ""): string {
  if (engine === "searxng") {
    const base = searxngUrl.trim().replace(/\/+$/, "");
    if (!base) throw new Error("searxngUrl is empty; set it in Settings → Веб");
    return `${base}/search?q=${encodeURIComponent(query)}&format=json`;
  }
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

/** html.duckduckgo.com result page: `result__a` title links followed by `result__snippet`. */
export function parseDuckDuckGo(html: string, max = 8): SearchResult[] {
  const results: SearchResult[] = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < max) {
    const url = unwrapDuck(decode(m[1] ?? ""));
    if (!url) continue;
    results.push({ title: strip(m[2] ?? ""), url, snippet: strip(m[3] ?? "") });
  }
  return results;
}

/** SearXNG `format=json`: `{ results: [{ title, url, content }] }`. */
export function parseSearxng(body: string, max = 8): SearchResult[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("SearXNG did not answer with JSON; enable the json format in its settings.yml (search.formats)");
  }
  const list = data && typeof data === "object" && Array.isArray((data as { results?: unknown }).results) ? ((data as { results: unknown[] }).results) : [];
  const out: SearchResult[] = [];
  for (const r of list) {
    if (out.length >= max) break;
    if (!r || typeof r !== "object") continue;
    const { title, url, content } = r as { title?: unknown; url?: unknown; content?: unknown };
    if (typeof url !== "string" || !isShownUrl(url)) continue;
    out.push({ title: strip(typeof title === "string" ? title : url), url, snippet: strip(typeof content === "string" ? content : "") });
  }
  return out;
}

export function unwrapDuck(href: string): string | undefined {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    const target = uddg ? decodeURIComponent(uddg) : url.toString();
    return isShownUrl(target) ? target : undefined;
  } catch {
    return undefined;
  }
}
