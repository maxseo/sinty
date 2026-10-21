import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { PublicNet } from "@sinty/sdk";

/** The part of Playwright this plugin uses. */
export interface BrowserPage {
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  goto(url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  click(selector: string, opts: { timeout: number }): Promise<unknown>;
  fill(selector: string, text: string, opts?: { timeout: number }): Promise<unknown>;
  keyboard: { press(key: string): Promise<unknown> };
  screenshot(opts: { path: string; fullPage: boolean }): Promise<unknown>;
}
interface BrowserContext {
  newPage(): Promise<BrowserPage>;
}
interface BrowserApp {
  newContext(opts: { acceptDownloads: boolean; serviceWorkers: "block" }): Promise<BrowserContext>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: {
    launch(opts: { headless: boolean; proxy: { server: string; username: string; password: string; bypass: string }; args: string[] }): Promise<BrowserApp>;
  };
}

let cached: Playwright | undefined;

/**
 * Playwright from the plugin's own dependencies; a patched copy of this plugin in $SINTY_HOME/plugins has no
 * node_modules of its own, so it falls back to the install, found next to @sinty/sdk.
 */
async function loadPlaywright(): Promise<Playwright> {
  if (cached) return cached;
  let first: unknown;
  try {
    cached = (await import("playwright")) as unknown as Playwright;
    return cached;
  } catch (e) {
    first = e;
  }
  let path: string;
  try {
    path = createRequire(import.meta.resolve("@sinty/sdk")).resolve("playwright");
  } catch {
    const code = first && typeof first === "object" && "code" in first ? String(first.code) : "";
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") throw new Error("playwright is not installed. In the Sinty app folder run: npx playwright install chromium");
    throw new Error(`playwright did not load: ${first instanceof Error ? first.message : String(first)}`);
  }
  cached = (await import(pathToFileURL(path).href)) as unknown as Playwright;
  return cached;
}

/** Only http(s) pages; file:, data: and the like never reach the browser. */
export function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("url is not valid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("only http and https");
}

/** After a navigation the page must still be an http(s) page (or the blank start page). */
export function assertPageUrl(url: string): void {
  if (url === "about:blank") return;
  if (!/^https?:/i.test(url)) throw new Error(`the page moved to ${url.split(":")[0]}: which is not allowed`);
}

/**
 * Opens `url` in headless Chromium whose every connection goes through the core's proxy (`ctx.net.public.proxy()`):
 * the core resolves each host and refuses private addresses, loopback included (Playwright forces `<-loopback>`
 * into the bypass list so localhost is proxied too). WebRTC may not send UDP around the proxy.
 */
export async function withBrowser<T>(net: PublicNet, url: string, timeoutMs: number, run: (page: BrowserPage) => Promise<T>): Promise<T> {
  assertHttpUrl(url);
  await net.check(url);
  const playwright = await loadPlaywright();
  const proxy = await net.proxy();
  const browser = await playwright.chromium.launch({
    headless: true,
    proxy: { server: proxy.server, username: proxy.username, password: proxy.password, bypass: "" },
    args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic", "--no-pings"],
  });
  try {
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    assertPageUrl(page.url());
    return await run(page);
  } finally {
    await browser.close();
  }
}
