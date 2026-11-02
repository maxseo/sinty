import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, ToolError, z } from "@sinty/sdk";
import { compositionMeta, compositionRoot, ensureThumb, findFfmpeg, findVideo, inlineAssets, insideDir, installedVersion, listSlugs, localCli, SLUG } from "./gallery.js";
import { tabHtml } from "./tab-page.js";
import { readMark, updateAvailable, writeMark, type Remote } from "./updates.js";

const TAB_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "media-src data:",
  "frame-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function remoteOf(fetch: (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>): Promise<Remote> {
  const npmRes = await fetch("https://registry.npmjs.org/hyperframes", { headers: { accept: "application/json" } });
  if (!npmRes.ok) throw new Error(`npm ${npmRes.status}`);
  const npm = (await npmRes.json()) as { "dist-tags"?: { latest?: string } };
  const version = npm["dist-tags"]?.latest ?? "";
  const gh = await fetch("https://api.github.com/repos/heygen-com/hyperframes/commits/main", {
    headers: { accept: "application/vnd.github+json", "user-agent": "sinty-hyperframes" },
  });
  if (!gh.ok) throw new Error(`github ${gh.status}`);
  const commit = (await gh.json()) as { sha?: string; commit?: { message?: string; committer?: { date?: string } } };
  return {
    version,
    sha: commit.sha ?? "",
    date: commit.commit?.committer?.date ?? "",
    title: (commit.commit?.message ?? "").split("\n")[0] ?? "",
  };
}

/** Playwright keeps Chromium beside the Sinty install. The plugin process cannot read that folder itself. */
function playwrightChrome(): string | undefined {
  const local = process.env.LOCALAPPDATA || join(process.cwd(), "..", "..", "..", "..");
  const ps = join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawnSync(ps, ["-NoProfile", "-Command", "Get-ChildItem (Join-Path $env:LOCALAPPDATA 'ms-playwright') -Filter chrome.exe -Recurse -Depth 4 -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, LOCALAPPDATA: local },
  });
  const line = child.stdout?.split(/\r?\n/).find((row) => row.trim().toLowerCase().endsWith("chrome.exe"));
  return line?.trim();
}

/** Bins from the Программы tab. Missing folders are harmless on PATH. The process cannot stat this directory. */
function toolBins(): string[] {
  const local = process.env.LOCALAPPDATA || join(process.cwd(), "..", "..", "..", "..");
  const tools = join(local, "Sinty", "tools");
  return [join(tools, "ffmpeg"), join(tools, "python"), join(tools, "python", "Scripts"), join(tools, "magick")];
}

const BS = String.fromCharCode(92);
const DQ = String.fromCharCode(34);

/** Node on Windows cannot spawn a `.cmd` directly. */
function wrapArg(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  let out = "";
  for (const ch of value) out += ch === DQ ? BS + DQ : ch;
  return DQ + out + DQ;
}

/**
 * Node 24 copies this process's --permission grants into a child's NODE_OPTIONS.
 * npm then cannot read its own files. permissions.shell already allows a child
 * that the model does not confine, so the child gets a grant that can read and write.
 * The string must already contain --permission: otherwise Node appends the narrow grants.
 */
const OPEN_NODE_OPTIONS = "--permission --allow-fs-read=* --allow-fs-write=* --allow-child-process --disable-warning=SecurityWarning";

function run(cmd: string, args: string[], cwd: string, timeoutMs = 600_000): Promise<{ code: number; out: string }> {
  const chrome = playwrightChrome();
  const bins = toolBins();
  const env = {
    ...process.env,
    NODE_OPTIONS: OPEN_NODE_OPTIONS,
    ...(bins.length ? { PATH: [...bins, process.env.PATH].filter(Boolean).join(";") } : {}),
    ...(chrome ? { PUPPETEER_EXECUTABLE_PATH: chrome, CHROME_PATH: chrome } : {}),
  };
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    const line = [cmd, ...args].map(wrapArg).join(" ");
    const child = win
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", DQ + line + DQ], { cwd, windowsHide: true, windowsVerbatimArguments: true, env })
      : spawn(cmd, args, { cwd, windowsHide: true, shell: false, env });
    let out = "";
    const take = (buf: Buffer) => { out = (out + buf.toString("utf8")).slice(-8000); };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => { child.kill(); resolve({ code: 1, out: out + "\nтаймаут" }); }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: 1, out: String(err) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
}

export default definePlugin({
  name: "hyperframes",
  setup(ctx) {
    const dir = ctx.paths.data;
    mkdirSync(dir, { recursive: true });
    const fetchPublic = (url: string, init?: { headers?: Record<string, string> }) => ctx.net.public.fetch(url, init);

    async function status(rememberFirst: boolean) {
      const remote = await remoteOf(fetchPublic);
      let seen = readMark(dir);
      if (!seen && rememberFirst && remote.version && remote.sha) {
        seen = { version: remote.version, sha: remote.sha };
        writeMark(dir, seen);
      }
      return { update: updateAvailable(seen, remote), seen, remote, installed: installedVersion(join(dir, "cli")) };
    }

    ctx.tool({
      name: "hyperframes.updates",
      description: "Whether heygen-com/hyperframes moved since the tab last marked it seen. First call stores the current npm version and main commit and reports no update.",
      input: z.object({}),
      sideEffects: "read",
      idempotent: true,
      async run() {
        try {
          return { content: await status(true) };
        } catch (e) {
          throw new ToolError("hyperframes_update", e instanceof Error ? e.message : "не проверилось");
        }
      },
    });

    ctx.tool({
      name: "hyperframes.write",
      description: "Save index.html for one composition under the workspace folder hyperframes/<slug>. HTML needs data-composition-id, data-width, data-height and data-duration. The CLI renders that file.",
      input: z.object({ slug: z.string(), html: z.string().max(500_000) }),
      sideEffects: "write",
      idempotent: true,
      async run(args) {
        if (!SLUG.test(args.slug)) throw new ToolError("hyperframes_slug", "slug: латиница через дефис");
        const project = join(ctx.paths.workspace, "hyperframes", args.slug);
        mkdirSync(project, { recursive: true });
        writeFileSync(join(project, "index.html"), args.html, "utf8");
        return { content: { dir: project, file: "index.html" } };
      },
    });

    ctx.tool({
      name: "hyperframes.render",
      description: "Render hyperframes/<slug> to MP4. The file is copied to the chat project _out/video/<slug>/film.mp4. Uses the Playwright Chromium already on this machine. If FFmpeg, Python or ImageMagick is missing, call runtimes.install.",
      input: z.object({ slug: z.string() }),
      sideEffects: "external",
      timeoutMs: 600_000,
      idempotent: false,
      async run(args, tool) {
        if (!SLUG.test(args.slug)) throw new ToolError("hyperframes_slug", "slug: латиница через дефис");
        const project = join(ctx.paths.workspace, "hyperframes", args.slug);
        const local = localCli(join(dir, "cli"));
        const bin = local || (process.platform === "win32" ? "npx.cmd" : "npx");
        const result = await run(bin, local ? ["render"] : ["--yes", "hyperframes", "render"], project);
        if (result.code !== 0) throw new ToolError("hyperframes_render", result.out || `код ${result.code}`);
        const made = readdirSync(project).find((name) => name.toLowerCase().endsWith(".mp4"));
        const output = tool.workspace && made ? join(tool.workspace, "_out", "video", args.slug, "film.mp4") : made ? join(project, made) : "";
        if (tool.workspace && made && output) {
          mkdirSync(join(output, ".."), { recursive: true });
          copyFileSync(join(project, made), output);
        }
        return { content: { dir: project, output: output || result.out } };
      },
    });

    const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": TAB_CSP, "cache-control": "no-store" } });
    ctx.http({ method: "GET", path: "/tab/updates", public: true, surface: "updates", handler: () => html(tabHtml()) });
    ctx.http({
      method: "GET",
      path: "/status",
      surface: "updates",
      access: "view",
      handler: async () => {
        try {
          return json(await status(true));
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "не проверилось" }, 502);
        }
      },
    });
    ctx.http({
      method: "POST",
      path: "/seen",
      surface: "updates",
      access: "edit",
      handler: async () => {
        try {
          const remote = await remoteOf(fetchPublic);
          if (!remote.version || !remote.sha) return json({ error: "пустой ответ" }, 502);
          writeMark(dir, { version: remote.version, sha: remote.sha });
          return json({ ok: true, update: false, remote });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "не сохранилось" }, 502);
        }
      },
    });

    const fail = (message: string, status = 400): Response => json({ error: { message } }, status);
    const folderOf = (slug: string): string | undefined => {
      if (!SLUG.test(slug)) return undefined;
      const root = compositionRoot(ctx.paths.workspace);
      const folder = join(root, slug);
      if (!existsSync(join(folder, "index.html")) || !insideDir(root, folder)) return undefined;
      return folder;
    };

    ctx.http({
      method: "GET",
      path: "/items",
      surface: "updates",
      access: "view",
      handler: () => {
        try {
          const ffmpeg = findFfmpeg();
          const items = listSlugs(ctx.paths.workspace).map((slug) => {
            const folder = join(compositionRoot(ctx.paths.workspace), slug);
            const meta = compositionMeta(readFileSync(join(folder, "index.html"), "utf8"));
            const thumbPath = ensureThumb(folder, ffmpeg);
            const thumb = thumbPath ? `data:image/jpeg;base64,${readFileSync(thumbPath).toString("base64")}` : "";
            return { slug, name: meta.id || meta.title || slug, width: meta.width, height: meta.height, hasVideo: Boolean(findVideo(folder)), thumb };
          });
          return json({ items });
        } catch (e) {
          return fail(e instanceof Error ? e.message : "список не собрался", 500);
        }
      },
    });
    ctx.http({
      method: "GET",
      path: "/open",
      surface: "updates",
      access: "view",
      handler: (req) => {
        const url = new URL(req.url);
        const folder = folderOf(url.searchParams.get("slug") ?? "");
        if (!folder) return fail("нет такой композиции", 404);
        const view = url.searchParams.get("view") === "html" ? "html" : "video";
        if (view === "html") return json({ html: inlineAssets(folder, readFileSync(join(folder, "index.html"), "utf8")) });
        const video = findVideo(folder);
        if (!video) return fail("у этой композиции нет ролика", 404);
        const buf = readFileSync(video);
        if (buf.length > 12_000_000) return fail("ролик больше 12 МБ", 413);
        return json({ video: buf.toString("base64") });
      },
    });
    ctx.http({
      method: "POST",
      path: "/delete",
      surface: "updates",
      access: "edit",
      handler: async (req) => {
        const body = await req.json() as { slug?: string };
        const folder = folderOf(body.slug ?? "");
        if (!folder) return fail("нет такой композиции", 404);
        rmSync(folder, { recursive: true, force: true });
        return json({ ok: true });
      },
    });
    ctx.http({
      method: "POST",
      path: "/update",
      surface: "updates",
      access: "edit",
      handler: async () => {
        try {
          const remote = await remoteOf(fetchPublic);
          if (!remote.version) return fail("пустой ответ npm", 502);
          const prefix = join(dir, "cli");
          mkdirSync(prefix, { recursive: true });
          const npm = process.platform === "win32" ? "npm.cmd" : "npm";
          const result = await run(npm, ["install", "--prefix", prefix, "--no-fund", "--no-audit", `hyperframes@${remote.version}`], prefix, 180_000);
          if (result.code !== 0) return fail(result.out.slice(-500) || "npm не установил пакет", 502);
          if (remote.sha) writeMark(dir, { version: remote.version, sha: remote.sha });
          return json({ ok: true, installed: installedVersion(prefix), remote });
        } catch (e) {
          return fail(e instanceof Error ? e.message : "не обновилось", 502);
        }
      },
    });
  },
});
