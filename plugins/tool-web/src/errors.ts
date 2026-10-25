import { ToolError } from "@sinty/sdk";

/**
 * Error codes and hints of the web tools. The code says who is at fault, so the model and the supervisor can tell a
 * wrong call from a site that refuses:
 * - `net_blocked`, `bad_request`: the call itself (a private or non-http(s) address, an invalid url);
 * - `http_4xx`, `http_5xx`, `too_large`, `timeout`, `net_failed`: the target site or the network, not the call
 *   (the supervisor treats these as `external_error` and never stores them as incidents);
 * - `web_failed`: anything else (a browser action, a selector, a missing Playwright).
 * Codes and hints from the core (`ctx.net.public`) are kept as they are.
 */

export const HINTS = {
  net_blocked: "Only public http(s) pages. Private hosts are blocked.",
  bad_request: "Use an absolute http(s) url.",
  too_large_fetch: "The file is larger than the download size limit (Settings → Web → max download size). Raise maxFetchMb or pick a smaller file.",
  too_large: "The page is larger than the page size limit (Settings → Веб → «Предел размера страницы»). Try web.interact, or another page with the same data.",
  timeout: "The site did not answer in time. Try once more later, or use another source.",
  net_failed: "The site could not be reached (DNS, connection or TLS error). Check the address, or use another source.",
  antibot:
    "The site refuses automated requests (anti-bot protection or a login wall). Do not retry web.read on this site: try web.interact (a real browser) once, or take the data from another source.",
  rate_limited: "The site rate-limits requests (too many requests). Do not retry now: try web.interact later, or use another source.",
  not_found: "The page does not exist. Do not guess urls: find the right one with web.search or web.links.",
  client: "The site rejected the request. Check the url, or use another source.",
  server: "The site has a server error. Try once more later, or use another source.",
  web_failed: "Check the arguments; for browser actions check the url and the CSS selectors.",
} as const;

const CORE_CODES = new Set(["net_blocked", "net_denied", "bad_request", "too_large", "timeout", "net_failed", "secret_missing"]);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The hint for an HTTP status from a target site. */
export function statusHint(status: number): string {
  if (status === 401 || status === 403 || status === 407 || status === 451) return HINTS.antibot;
  if (status === 429) return HINTS.rate_limited;
  if (status === 404 || status === 410) return HINTS.not_found;
  return status >= 500 ? HINTS.server : HINTS.client;
}

/** A non-2xx answer of a target site: `http_4xx` or `http_5xx`, the status and host in the message. */
export function httpError(status: number, statusText: string, url: string): ToolError {
  const code = status >= 500 ? "http_5xx" : "http_4xx";
  const text = statusText && statusText !== String(status) ? ` ${statusText}` : "";
  return new ToolError(code, `page returned ${status}${text} (${hostOf(url)})`, { hint: statusHint(status) });
}

/** Any error of a web tool as a ToolError with a code and a hint that fit it. */
export function toWebError(e: unknown): ToolError {
  if (e instanceof ToolError) {
    if (e.code === "aborted") return e;
    if (e.code.startsWith("http_")) return e;
    if (CORE_CODES.has(e.code)) {
      const own = (HINTS as Record<string, string>)[e.code];
      return new ToolError(e.code, e.message, { hint: e.code === "net_blocked" ? (e.hint ?? HINTS.net_blocked) : e.code === "too_large" ? (e.hint ?? own ?? HINTS.web_failed) : (own ?? e.hint ?? HINTS.web_failed) });
    }
    return new ToolError(e.code, e.message, { hint: e.hint ?? HINTS.web_failed });
  }
  const message = e instanceof Error ? e.message : String(e);
  // Playwright reports a navigation the core's proxy refused as a tunnel or proxy error.
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(message)) return new ToolError("net_blocked", message, { hint: HINTS.net_blocked });
  if (/Timeout \d+ms exceeded|ERR_TIMED_OUT/.test(message) && /goto|navigat/i.test(message)) return new ToolError("timeout", message, { hint: HINTS.timeout });
  if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_(REFUSED|RESET|CLOSED)|ERR_SSL|ERR_CERT/.test(message)) return new ToolError("net_failed", message, { hint: HINTS.net_failed });
  return new ToolError("web_failed", message, { hint: HINTS.web_failed });
}

const BLOCK_TITLE = /captcha|капч|too many requests|access denied|attention required|are you a robot|вы не робот|доступ (ограничен|запрещ)|слишком много запросов|just a moment|security check|проверка безопасности/i;
const BLOCK_TEXT = /captcha|капч|too many requests|are you a robot|not a robot|вы не робот|unusual traffic|подозрительн\S* трафик|слишком много запросов|enable javascript and cookies|checking your browser/i;

/**
 * Why an opened page looks like a block page rather than the content: an HTTP error status, or a captcha /
 * anti-bot / rate-limit page by its title or its text, only when the page is short (block pages are). Undefined for
 * a normal page.
 */
export function blockedReason(status: number | undefined, title: string, markdown: string): string | undefined {
  if (status !== undefined && status >= 400) return `the site answered HTTP ${status}`;
  // Block pages are short; a long page with such a title is an article about captchas.
  if (markdown.length >= 3000) return undefined;
  if (BLOCK_TITLE.test(title)) return `the page title "${title.slice(0, 80)}" looks like a captcha or anti-bot page`;
  if (BLOCK_TEXT.test(markdown)) return "the page text looks like a captcha or anti-bot page";
  return undefined;
}

/** The note added to a browser result whose page is a block page. */
export function blockedNote(reason: string): string {
  return `This is probably not the content you wanted: ${reason}. Do not repeat the same request; use another source, or tell the user the site blocks automated access.`;
}
