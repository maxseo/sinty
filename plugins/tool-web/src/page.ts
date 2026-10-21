import { isLocalHostname, isPrivateAddress, parseIPv4, parseIPv6 } from "@sinty/sdk";

/** HTML to Markdown and links. Moved from the core (packages/core/src/web.ts) without behaviour changes. */

export interface PageDoc {
  url: string;
  title: string;
  markdown: string;
  links: { text: string; url: string }[];
  untrusted: true;
}

export interface PageLimits {
  maxChars: number;
  maxLinks: number;
}

export const DEFAULT_LIMITS: PageLimits = { maxChars: 20_000, maxLinks: 40 };

/**
 * Whether a link is worth showing: http(s) and not an obviously local or private host. This is cosmetic; the core
 * checks the real address again when the model opens the link.
 */
export function isShownUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLocalHostname(host)) return false;
  if ((parseIPv4(host) || parseIPv6(host)) && isPrivateAddress(host)) return false;
  return true;
}

export function htmlToMarkdown(html: string, base: string, limits: PageLimits = DEFAULT_LIMITS): { title: string; markdown: string; links: { text: string; url: string }[] } {
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
  if (md.length > limits.maxChars) md = `${md.slice(0, limits.maxChars)}\n…[truncated]`;
  const seen = new Set<string>();
  const unique = links.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true))).slice(0, limits.maxLinks);
  return { title, markdown: md, links: unique };
}

export function resolveHref(base: string, href: string): string | undefined {
  if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) return undefined;
  try {
    const url = new URL(href, base).toString();
    return isShownUrl(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

export function match(html: string, re: RegExp): string | undefined {
  return re.exec(html)?.[1];
}

export function strip(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
