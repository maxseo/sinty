import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BrowserContext, BrowserType, Page } from "playwright";

/** Existing Web Tools' opt-in owned persistent browser adapter. No CUA, personal profile or raw CDP. */
export class WebPilotError extends Error { constructor(readonly code: string, message: string) { super(message); } }
export interface PilotProxy { server: string; username: string; password: string; close?(): Promise<void> }
export interface WebPilotOptions {
  profiles: string;
  /** Trusted host starts the existing guarded proxy with ONLY the granted fixture host:port admitted. */
  proxy(origin: string): Promise<PilotProxy>;
  checkPublicUrl?(url: string): Promise<void>;
  headless?: boolean;
  launcher?: Pick<BrowserType, "launchPersistentContext">;
}
interface Prepared { context: BrowserContext; page: Page; proxy: PilotProxy; workspace: string; fixture: string; publicWeb: boolean; token: string; profile: string; lock: string; busy: boolean; closing: boolean; closed: boolean; mode: "agent" | "pausing" | "manual"; deadline: ReturnType<typeof setTimeout>; closePromise?: Promise<boolean> }
const fail = (code: string, message: string): never => { throw new WebPilotError(code, message); };
export function fixtureUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !u.port || u.pathname !== "/browser-pilot-fixture" || u.search || u.hash || u.username || u.password) fail("fixture_only", "Only the owner-granted loopback fixture is admitted");
  return u;
}
function inside(root: string, target: string): boolean { const r = relative(root, target); return r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r); }
/** Parent directories, junctions, symlinks, ADS/device paths and hard links fail closed. */
export function workspaceFile(root: string, path: string): string {
  const base = realpathSync(root), candidate = resolve(path);
  if (base !== root || !inside(base, candidate) || candidate === base || relative(base, candidate).includes(":")) fail("outside_workspace", "File is outside the canonical project");
  let cursor = base;
  for (const component of relative(base, candidate).split(sep)) { cursor = join(cursor, component); if (lstatSync(cursor).isSymbolicLink() || !inside(base, realpathSync(cursor))) fail("outside_workspace", "Linked project path is not allowed"); }
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_000_000) fail("outside_workspace", "Only a regular project file <=16MB is allowed");
  return candidate;
}
function directory(root: string, relativeName: string): string {
  if (realpathSync(root) !== root) fail("outside_workspace", "Root is not canonical");
  let cursor = root;
  for (const component of relativeName.split(sep)) { if (!component || component === ".." || component.includes(":")) fail("outside_workspace", "Invalid directory"); cursor = join(cursor, component); if (!existsSync(cursor)) mkdirSync(cursor); if (lstatSync(cursor).isSymbolicLink() || !lstatSync(cursor).isDirectory() || !inside(root, realpathSync(cursor))) fail("outside_workspace", "Directory escaped its root"); }
  return cursor;
}
export class WebToolsPilotDriver {
  private readonly sessions = new Map<string, Prepared>();
  private readonly preparing = new Set<string>();
  constructor(private readonly options: WebPilotOptions) {}
  async prepare(args: { allow_launch: true; profile: { mode: "isolated_named"; name: string }; session: string; fixture?: string; workspace?: string; scope?: "public" }, signal: AbortSignal): Promise<{ targetId: string; tabId: string }> {
    if (signal.aborted) throw Error("cancelled");
    if ((!args.fixture && args.scope !== "public") || (args.scope === "public" && !this.options.checkPublicUrl) || !args.workspace || args.allow_launch !== true || args.profile?.mode !== "isolated_named" || !/^sinty-[a-f0-9]{48}$/.test(args.profile.name) || !/^[a-zA-Z0-9-]{1,100}$/.test(args.session)) fail("invalid_binding", "Trusted named profile/project/fixture binding required");
    const publicWeb = args.scope === "public", fixture = publicWeb ? "" : fixtureUrl(args.fixture!).href, workspace = realpathSync(args.workspace!);
    if (workspace !== args.workspace || this.sessions.has(args.session) || this.preparing.has(args.session)) fail("profile_busy", "Session already prepared or noncanonical workspace");
    mkdirSync(this.options.profiles, { recursive: true });
    const root = realpathSync(this.options.profiles);
    if (root !== resolve(this.options.profiles) || lstatSync(root).isSymbolicLink()) fail("outside_workspace", "Profile root must be a real dedicated directory");
    const profile = directory(root, args.profile.name), lock = profile + ".lock";
    let fd: number;
    try { fd = openSync(lock, "wx"); } catch { return fail("profile_busy", "Dedicated profile is already locked; unknown stale locks are never removed automatically"); }
    try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
    this.preparing.add(args.session);
    let context: BrowserContext | undefined, proxy: PilotProxy | undefined, aborted: boolean = Boolean(signal.aborted);
    const abort = (): void => { aborted = true; if (context) void context.close().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      proxy = await this.options.proxy(publicWeb ? "" : new URL(fixture).origin);
      const launcher = this.options.launcher ?? (await import("playwright")).chromium;
      context = await launcher.launchPersistentContext(profile, { headless: this.options.headless ?? false, timeout: 20_000, proxy: { server: proxy.server, username: proxy.username, password: proxy.password, bypass: "<-loopback>" }, acceptDownloads: true, viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, serviceWorkers: "block", args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic", "--no-pings", "--disable-background-networking"] });
      if (aborted) throw Error("cancelled");
      // Install interception before any fixture navigation; fail closed even for popups and frames.
      await context.route("**/*", async route => { let admitted = false; try { const u = new URL(route.request().url()); if (publicWeb) { await this.options.checkPublicUrl!(publicWebUrl(u.href).href); admitted = true; } else admitted = u.origin === new URL(fixture).origin && ["/browser-pilot-fixture", "/browser-pilot-download"].includes(u.pathname) && route.request().method() === "GET"; } catch {} if (admitted) await route.continue(); else await route.abort("blockedbyclient"); });
      await context.routeWebSocket("**/*", socket => socket.close({ code: 1008, reason: "Owned browser currently blocks WebSockets" }));
      const pages = context.pages(); const page = pages[0] ?? await context.newPage();
      for (const extra of pages.slice(1)) await extra.close();
      if (publicWeb) await page.goto("about:blank");
      page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(15_000);
      context.on("page", opened => { if (opened !== page) void opened.close().catch(() => {}); });
      const token = randomUUID(), deadline = setTimeout(() => void this.close(args.session), 20 * 60_000); deadline.unref();
      const s: Prepared = { context, page, proxy, workspace, fixture, publicWeb, token, profile, lock, busy: false, closing: false, closed: false, mode: "agent", deadline };
      this.sessions.set(args.session, s);
      context.once("close", () => { s.closed = true; });
      return { targetId: token, tabId: token };
    } catch (error) {
      let closed = !context;
      if (context) closed = await this.boundedClose(context);
      await proxy?.close?.().catch(() => {});
      if (closed) unlinkSync(lock); // Unknown closure keeps its lock, never overlap a profile.
      throw error;
    } finally { signal.removeEventListener("abort", abort); this.preparing.delete(args.session); }
  }
  private owned(session: string): Prepared { const s = this.sessions.get(session); if (!s || s.closing || s.closed) return fail("session_closed", "Owned browser is not active"); return s; }
  status(session: string): { mode: string; pending: boolean } { const s = this.owned(session); return { mode: s.mode, pending: s.busy }; }
  /** Trusted OWNER control only; not part of the model-facing call interface. */
  pause(session: string): { mode: string; pending: boolean } { const s = this.owned(session); s.mode = s.busy ? "pausing" : "manual"; return this.status(session); }
  resume(session: string): void { const s = this.owned(session); if (s.busy || s.mode !== "manual") fail("browser_busy", "Wait until takeover is actually manual"); s.mode = "agent"; }
  async call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const session = String(args.session ?? ""), s = this.owned(session);
    if (args.target_id !== s.token || args.tab_id !== s.token) fail("wrong_target", "Target belongs to a different owned session");
    if (s.busy || s.mode !== "agent") fail("browser_busy", "Browser is pending or manually owned");
    if (signal.aborted) { await this.close(session); throw Error("cancelled"); }
    s.busy = true;
    const abort = (): void => { void this.close(session); };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 25_000); timer.unref();
    try {
      const page = s.page;
      const locator = () => { if (typeof args.ref !== "string" || !args.ref || args.ref.length > 256) return fail("invalid_ref", "Use a CSS selector from this fixture"); return page.locator(s.publicWeb ? "css=" + args.ref : args.ref); };
      const outcome = await (async () => { switch (tool) {
        case "browser_navigate": {
          const url = s.publicWeb ? publicWebUrl(String(args.url ?? "")).href : s.fixture;
          if (s.publicWeb) await this.options.checkPublicUrl!(url); else if (args.url !== s.fixture) fail("fixture_only", "Navigation is limited to the owner fixture");
          await page.goto(url, { waitUntil: "domcontentloaded" }); return { navigated: true, url: displayUrl(page.url()) };
        }
        case "browser_click": await locator().click(); return { clicked: true };
        case "browser_type": if (typeof args.text !== "string" || args.text.length > 10_000) fail("invalid_args", "Text must be <=10000 characters"); await locator().fill(args.text as string); return { filled: true };
        case "browser_select": if (typeof args.value !== "string") fail("invalid_args", "Select value required"); await locator().selectOption(args.value as string); return { selected: true };
        case "browser_pointer": if (args.action !== "scroll" || !Number.isInteger(args.delta_y) || Math.abs(args.delta_y as number) > 2000) fail("invalid_args", "Only bounded page scrolling is supported"); await page.mouse.wheel(0, args.delta_y as number); return { scrolled: true };
        case "get_browser_state": {
          try {
            if (s.publicWeb) { if (page.url() !== "about:blank") await this.options.checkPublicUrl!(publicWebUrl(page.url()).href); } else if (page.url() !== s.fixture) fail("fixture_only", "Open the granted fixture first");
            const out = directory(s.workspace, join("_out", "browser-pilot", session)); const screenshot = join(out, randomUUID() + ".png");
            const pixels = await page.screenshot({ path: screenshot, fullPage: false, ...(s.publicWeb ? { mask: [page.locator("input[type=password],input[autocomplete=one-time-code]")] } : {}) });
            if (pixels.length > 4_000_000) fail("image_too_large", "Screenshot exceeds 4MB budget");
            let snapshot: { title: string; text: string; controls: unknown[] };
            if (s.publicWeb) {
              // One fixed, bounded, read-only DOM snapshot. No model-provided JS, per-node waits or arbitrary eval API.
              snapshot = await page.locator("body").evaluate(body => {
                const root = body as any, selector = "input,textarea,select,button,a,[role=button],[role=link]";
                const controls = (Array.from(root.querySelectorAll(selector)).slice(0, 64) as any[]).map((el, index) => {
                  const id = el.getAttribute("id"), name = el.getAttribute("name");
                  const ref = id ? '[id=' + JSON.stringify(id) + ']' : ':nth-match(:is(' + selector + '), ' + (index + 1) + ')';
                  return { ref, id, name, type: el.getAttribute("type"), href: el.getAttribute("href")?.slice(0, 2048), label: (el.getAttribute("aria-label") || el.innerText || el.textContent || "").slice(0, 200) };
                });
                return { title: String(root.ownerDocument.title).slice(0, 1000), text: String(root.innerText || "").slice(0, 10000), controls };
              }, undefined, { timeout: 3000 });
            } else {
              const controls = []; for (const element of (await page.locator("input,textarea,select,button,a").all()).slice(0, 64)) controls.push({ id: await element.getAttribute("id"), name: await element.getAttribute("name"), type: await element.getAttribute("type"), label: (await element.innerText()).slice(0, 200) });
              snapshot = { title: await page.title(), text: (await page.locator("body").innerText()).slice(0, 10000), controls };
            }
            return { url: displayUrl(page.url()), ...snapshot, screenshot, untrusted: true, content: [{ type: "image", mimeType: "image/png", data: pixels.toString("base64") }] };
          } catch (error) {
            const code = (error as {code?:unknown})?.code;
            if (!code && !s.closed && !s.closing && !signal.aborted && !(typeof page.isClosed === "function" && page.isClosed())) fail(/timeout/i.test(String((error as Error).message)) ? "snapshot_timeout" : "snapshot_unstable", "Страница изменилась во время чтения. Агент может повторить state; ручное управление не включалось.");
            throw error;
          }
        }
        case "browser_set_input_files": {
          // Only core's owner-selected, workspace-validated staging paths reach this internal method.
          if (!Array.isArray(args.files) || args.files.length !== 1 || typeof args.files[0] !== "string") fail("invalid_args", "Exactly one owner-selected project file required");
          const source = workspaceFile(s.workspace, (args.files as string[])[0]!);
          const handle = openSync(source, "r"); let bytes: Buffer;
          try { const before = lstatSync(source), stat = fstatSync(handle); if (stat.ino !== before.ino || stat.dev !== before.dev || !stat.isFile() || stat.nlink !== 1 || stat.size > 16_000_000) fail("upload_changed", "Project file changed"); bytes = Buffer.alloc(stat.size); let offset = 0; while (offset < bytes.length) { const n = readSync(handle, bytes, offset, bytes.length - offset, offset); if (!n) fail("upload_changed", "Project file shrank while reading"); offset += n; } if (readSync(handle, Buffer.alloc(1), 0, 1, bytes.length)) fail("upload_changed", "Project file grew while reading"); } finally { closeSync(handle); }
          await locator().setInputFiles({ name: basename(source), mimeType: "application/octet-stream", buffer: bytes! }); return { attached: true, bytes: bytes!.length };
        }
        case "browser_download": {
          const root = directory(s.workspace, join("_out", "browser-pilot", session));
          if (realpathSync(String(args.destination_root)) !== root) fail("outside_workspace", "Download destination must be the broker-owned session output directory");
          const element = locator(); const event = page.waitForEvent("download", { timeout: 10_000 }); const clicked = element.click(); const [download] = await Promise.all([event, clicked]);
          const url = new URL(download.url()); if (!s.publicWeb && (url.origin !== new URL(s.fixture).origin || url.pathname !== "/browser-pilot-download")) { await download.cancel(); return fail("fixture_only", "Only the fixture download is admitted"); }
          if (s.publicWeb) await this.options.checkPublicUrl!(publicWebUrl(download.url()).href);
          const stream = await download.createReadStream(); if (!stream) fail("download_failed", "No download stream");
          const chunks: Buffer[] = []; let bytes = 0; for await (const chunk of stream!) { bytes += chunk.length; if (bytes > 20_000_000) { await download.cancel(); fail("too_large", "Download exceeds 20MB"); } chunks.push(Buffer.from(chunk)); }
          const suggested = s.publicWeb ? download.suggestedFilename().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "download.bin" : "fixture.txt";
          const file = join(root, randomUUID() + "-" + suggested); writeFileSync(file, Buffer.concat(chunks), { flag: "wx" }); return { path: file, bytes };
        }
        default: return fail("tool_not_allowed", "Only the narrow owned browser API is available; no desktop, clipboard, script or CDP tools");
      }
      })(); if (signal.aborted || s.closing) fail("cancelled", "Owned browser operation was cancelled"); return outcome;
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); s.busy = false; if (s.mode === "pausing") s.mode = "manual"; }
  }
  private async boundedClose(context: BrowserContext): Promise<boolean> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([context.close().then(() => true, () => false), new Promise<false>(r => { timer = setTimeout(() => r(false), 5000); })]); } finally { if (timer) clearTimeout(timer); } }
  async close(session: string): Promise<boolean> {
    const s = this.sessions.get(session); if (!s) return !this.preparing.has(session);
    if (s.closePromise) return s.closePromise;
    s.closing = true; clearTimeout(s.deadline);
    s.closePromise = (async () => { const closed = s.closed || await this.boundedClose(s.context); if (closed) { s.closed = true; await s.proxy.close?.().catch(() => {}); if (existsSync(s.lock)) unlinkSync(s.lock); this.sessions.delete(session); } return closed; })();
    return s.closePromise;
  }
  async stop(): Promise<boolean> { const results = await Promise.all([...this.sessions.keys()].map(session => this.close(session))); return !this.preparing.size && results.every(Boolean); }
}

/** Syntax only; trusted core DNS/pinned proxy checks are additionally mandatory in public mode. */
export function publicWebUrl(raw: string): URL { const u = new URL(raw); if (raw.length > 4096 || !["http:", "https:"].includes(u.protocol) || u.username || u.password) return fail("invalid_url", "Only public http(s), no credentials/file/data URLs"); return u; }
function displayUrl(raw: string): string { if (raw === "about:blank") return raw; const u = new URL(raw); u.username = ""; u.password = ""; u.search = ""; u.hash = ""; return u.href; }
