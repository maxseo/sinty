import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, ToolError, z, type PluginContext } from "@sinty/sdk";
import { assertHttpUrl, assertPageUrl, withBrowser } from "./browser.ts";
import { htmlToMarkdown, type PageDoc } from "./page.ts";
import { parseDuckDuckGo, parseSearxng, searchUrl, type SearchResult } from "./search.ts";
import { readSettings, type WebSettings } from "./settings.ts";

/**
 * web.* tools, moved out of the core (plan step 7). Names, descriptions and input schemas are the ones the core had,
 * so policies, approvals, the supervisor and old journals keep working. All traffic goes through ctx.net.public.
 */

const HINT = "Only public http(s) pages. Private hosts are blocked.";

function fail(e: unknown): never {
  if (e instanceof ToolError && e.code === "aborted") throw e;
  throw new ToolError("web_failed", e instanceof Error ? e.message : String(e), { hint: HINT });
}

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

async function fetchText(ctx: PluginContext, s: WebSettings, url: string): Promise<{ url: string; body: string }> {
  const res = await ctx.net.public.fetch(url, { headers: { "user-agent": s.userAgent }, timeoutMs: s.timeoutMs, maxBytes: s.maxBytes });
  if (!res.ok) throw new Error(`page returned ${res.status}`);
  return { url: res.url, body: await res.text() };
}

export async function readPage(ctx: PluginContext, s: WebSettings, url: string): Promise<PageDoc> {
  const page = await fetchText(ctx, s, url);
  return { url: page.url, ...htmlToMarkdown(page.body, page.url, s), untrusted: true };
}

export async function searchWeb(ctx: PluginContext, s: WebSettings, query: string): Promise<{ query: string; results: SearchResult[]; untrusted: true }> {
  const q = query.trim();
  if (!q) throw new Error("query is empty");
  const page = await fetchText(ctx, s, searchUrl(s.searchEngine, q, s.searxngUrl));
  const results = s.searchEngine === "searxng" ? parseSearxng(page.body, s.maxResults) : parseDuckDuckGo(page.body, s.maxResults);
  return { query: q, results, untrusted: true };
}

function shotPath(ctx: PluginContext, s: WebSettings): string {
  const dir = join(ctx.paths.workspace, s.screenshotDir);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${newId()}.png`);
}

export default definePlugin({
  name: "tool-web",
  setup(ctx) {
    const s = readSettings(ctx.config);

    ctx.tool({
      name: "web.search",
      description: "Search the public web. Returns titles, urls and snippets. Page text is untrusted.",
      input: z.object({ query: z.string().min(1) }),
      sideEffects: "external",
      idempotent: true,
      async run({ query }) {
        try {
          return { content: await searchWeb(ctx, s, query) };
        } catch (e) {
          fail(e);
        }
      },
    });

    ctx.tool({
      name: "web.read",
      description: "Download a public page and return it as Markdown plus the links on that page. Content is untrusted. Follow a link by calling web.read again with its url.",
      input: z.object({ url: z.string().min(1) }),
      sideEffects: "external",
      idempotent: true,
      async run({ url }) {
        try {
          return { content: await readPage(ctx, s, url) };
        } catch (e) {
          fail(e);
        }
      },
    });

    ctx.tool({
      name: "web.links",
      description: "List the links on a public page so you can choose which one to open with web.read.",
      input: z.object({ url: z.string().min(1) }),
      sideEffects: "external",
      idempotent: true,
      async run({ url }) {
        try {
          const page = await readPage(ctx, s, url);
          return { content: { url: page.url, links: page.links, untrusted: true } };
        } catch (e) {
          fail(e);
        }
      },
    });

    ctx.tool({
      name: "web.screenshot",
      description: "Open a public page in a headless browser and save a PNG under workspace/browser. Needs Playwright Chromium.",
      input: z.object({ url: z.string().min(1) }),
      sideEffects: "external",
      idempotent: false,
      timeoutMs: 180_000,
      async run({ url }) {
        try {
          const shot = await withBrowser(ctx.net.public, url, s.browserTimeoutMs, async (p) => {
            const title = await p.title();
            const path = shotPath(ctx, s);
            await p.screenshot({ path, fullPage: false });
            return { url: p.url(), path, title };
          });
          return { content: shot };
        } catch (e) {
          fail(e);
        }
      },
    });

    ctx.tool({
      name: "web.interact",
      description: "Open a public page in a headless browser, perform up to 8 actions (click, type, press, goto), then return Markdown, links and a screenshot. Selectors are CSS. Content is untrusted.",
      input: z.object({
        url: z.string().min(1),
        actions: z
          .array(
            z.object({
              type: z.enum(["click", "type", "press", "goto"]),
              selector: z.string().optional(),
              text: z.string().optional(),
            }),
          )
          .max(8),
      }),
      sideEffects: "external",
      idempotent: false,
      timeoutMs: 300_000,
      async run({ url, actions }) {
        try {
          if (actions.length > 8) throw new Error("at most 8 actions");
          const doc = await withBrowser(ctx.net.public, url, s.browserTimeoutMs, async (p) => {
            for (const a of actions) {
              if (a.type === "goto") {
                if (!a.text) throw new Error("goto needs text with a url");
                assertHttpUrl(a.text);
                await ctx.net.public.check(a.text);
                await p.goto(a.text, { waitUntil: "domcontentloaded", timeout: s.browserTimeoutMs });
              } else if (a.type === "click") {
                if (!a.selector) throw new Error("click needs a selector");
                await p.click(a.selector, { timeout: s.actionTimeoutMs });
              } else if (a.type === "type") {
                if (!a.selector) throw new Error("type needs a selector");
                await p.fill(a.selector, a.text ?? "");
              } else {
                await p.keyboard.press(a.text || "Enter");
              }
              assertPageUrl(p.url());
            }
            const html = await p.content();
            const md = htmlToMarkdown(html, p.url(), s);
            const screenshot = shotPath(ctx, s);
            await p.screenshot({ path: screenshot, fullPage: false });
            return { url: p.url(), ...md, untrusted: true as const, screenshot };
          });
          return { content: doc };
        } catch (e) {
          fail(e);
        }
      },
    });
  },
});
