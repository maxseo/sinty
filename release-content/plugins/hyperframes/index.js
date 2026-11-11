import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { definePlugin, ToolError, z } from "@sinty/sdk";
import { readMark, updateAvailable, writeMark } from "./updates.js";
import { renderWithCdp } from "./render-cdp.js";
import { compositionMeta, compositionRoot, ensureThumb, findFfmpeg, findVideo, inlineAssets, insideDir, installedVersion, listSlugs, localCli, SLUG } from "./gallery.js";
import { tabHtml } from "./tab-page.js";

const TAB_CSP = ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "img-src data:", "media-src data:", "frame-src data: blob:", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"].join("; ");
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function remoteOf(fetch) {
  const npmRes = await fetch("https://registry.npmjs.org/hyperframes", { headers: { accept: "application/json" } });
  if (!npmRes.ok)
    throw new Error(`npm ${npmRes.status}`);
  const npm = (await npmRes.json());
  const version = npm["dist-tags"]?.latest ?? "";
  const gh = await fetch("https://api.github.com/repos/heygen-com/hyperframes/commits/main", {
    headers: { accept: "application/vnd.github+json", "user-agent": "sinty-hyperframes" },
  });
  if (!gh.ok)
    throw new Error(`github ${gh.status}`);
  const commit = (await gh.json());
  return {
    version,
    sha: commit.sha ?? "",
    date: commit.commit?.committer?.date ?? "",
    title: (commit.commit?.message ?? "").split("\n")[0] ?? "",
  };
}

/** Плагин не может обходить чужие каталоги, поэтому проверяем известные пути. */
function knownChrome() {
  if (process.platform !== "win32") return [process.env.SINTY_CHROMIUM ?? ""].filter(Boolean);
  const la = process.env.LOCALAPPDATA ?? "";
  const out = [];
  for (const ver of ["chromium-1248", "chromium-1200", "chromium-1181", "chromium-1148", "chromium-1134", "chromium-1129", "chromium-1124"]) {
    out.push(join(la, "ms-playwright", ver, "chrome-win64", "chrome.exe"));
    out.push(join(la, "ms-playwright", ver, "chrome-win", "chrome.exe"));
  }
  return out;
}

function knownFfmpeg() {
  if (process.platform !== "win32") return [process.env.SINTY_FFMPEG ?? ""].filter(Boolean);
  const la = process.env.LOCALAPPDATA ?? "";
  const roots = la ? [join(la, "Sinty", "tools")] : [];
  const out = [];
  for (const root of roots) {
    for (const ver of ["ffmpeg-9.0.2-essentials_build", "ffmpeg-8.0-essentials_build", "ffmpeg-7.1-essentials_build", "ffmpeg-7.0.2-essentials_build", "ffmpeg"]) {
      out.push(join(root, ver, "bin", "ffmpeg.exe"));
    }
    out.push(join(root, "ffmpeg.exe"));
  }
  return out;
}

function firstExisting(list) {
  for (const p of list) {
    try { if (existsSync(p)) return p; } catch { /* недоступно */ }
  }
  return "";
}

const BS = String.fromCharCode(92);
const DQ = String.fromCharCode(34);
function wrapArg(s) {
  if (!/[\s"]/.test(s))
    return s;
  let out = "";
  for (const ch of s)
    out += ch === DQ ? BS + DQ : ch;
  return DQ + out + DQ;
}

/** Node 24 copies this process's --permission grants into NODE_OPTIONS. The string must already contain --permission, or the narrow grants are appended and npm cannot read its own files. */
const OPEN_NODE_OPTIONS = "--permission --allow-fs-read=* --allow-fs-write=* --allow-child-process --disable-warning=SecurityWarning";

/** На Windows .cmd нельзя спавнить напрямую: Node 24 даёт EINVAL. Идём через cmd.exe. */
function run(cmd, args, cwd, timeoutMs = 60_000) {
  const env = { ...process.env, NODE_OPTIONS: OPEN_NODE_OPTIONS };
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    const line = [cmd, ...args].map(wrapArg).join(" ");
    const child = win
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", DQ + line + DQ], {
          cwd, windowsHide: true, windowsVerbatimArguments: true, env,
        })
      : spawn(cmd, args, { cwd, windowsHide: true, env });
    let out = "";
    const take = (buf) => { out = (out + buf.toString("utf8")).slice(-4000); };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* noop */ } resolve({ code: 1, out: out + "\nтаймаут" }); }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: 1, out: String(err) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
}

export default definePlugin({
  name: "hyperframes",
  setup(ctx) {
    const dir = ctx.paths.data;
    mkdirSync(dir, { recursive: true });
    const fetchPublic = (url, init) => ctx.net.public.fetch(url, init);

    async function status(rememberFirst) {
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
        }
        catch (e) {
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
        if (!SLUG.test(args.slug))
          throw new ToolError("hyperframes_slug", "slug: латиница через дефис");
        const project = join(ctx.paths.workspace, "hyperframes", args.slug);
        mkdirSync(project, { recursive: true });
        writeFileSync(join(project, "index.html"), args.html, "utf8");
        return { content: { dir: project, file: "index.html" } };
      },
    });

    ctx.tool({
      name: "hyperframes.render",
      description: "Render hyperframes/<slug> to MP4 in the chat project _out/video/<slug>/film.mp4. Tries the hyperframes CLI, then Chrome DevTools Protocol + FFmpeg.",
      input: z.object({
        slug: z.string(),
        fps: z.number().int().min(1).max(60).optional(),
        out: z.string().optional(),
        chrome: z.string().optional(),
        ffmpeg: z.string().optional(),
        skipCli: z.boolean().optional(),
      }),
      sideEffects: "external",
      timeoutMs: 600000,
      idempotent: false,
      async run(args, tool) {
        if (!SLUG.test(args.slug))
          throw new ToolError("hyperframes_slug", "slug: латиница через дефис");
        const project = join(ctx.paths.workspace, "hyperframes", args.slug);
        const entry = join(project, "index.html");
        if (!existsSync(entry))
          throw new ToolError("hyperframes_missing", `нет ${entry} — сначала hyperframes.write`);

        const outDir = tool && tool.workspace ? join(tool.workspace, "_out", "video", args.slug) : project;
        if (tool && tool.workspace) mkdirSync(outDir, { recursive: true });
        const outPath = join(outDir, args.out ?? "film.mp4");
        const fps = args.fps ?? 30;
        const notes = [];

        if (!args.skipCli) {
          const local = localCli(join(dir, "cli"));
          const bin = local || (process.platform === "win32" ? "npx.cmd" : "npx");
          const cli = await run(bin, local ? ["render"] : ["--yes", "hyperframes", "render"], project, 70_000);
          if (cli.code === 0)
            return { content: { dir: project, output: cli.out, engine: "cli" } };
          notes.push("CLI не сработал → CDP + ffmpeg");
        }

        const chrome = args.chrome || firstExisting(knownChrome());
        const ffmpeg = args.ffmpeg || firstExisting(knownFfmpeg());
        if (!chrome)
          throw new ToolError("hyperframes_chrome", notes.join("\n") + "\n\nне нашла chromium.exe. Передайте путь параметром chrome.");
        if (!ffmpeg)
          throw new ToolError("hyperframes_ffmpeg", notes.join("\n") + "\n\nне нашла ffmpeg.exe. Передайте путь параметром ffmpeg.");

        try {
          const res = await renderWithCdp({
            chrome, ffmpeg, htmlPath: entry, outPath,
            profileDir: join(dir, "chrome-profile"),
            fps, width: 1920, height: 1080, maxSeconds: 150,
            log: (m) => notes.push(m),
          });
          return { content: { ...res, dir: project, engine: "cdp", notes } };
        }
        catch (e) {
          throw new ToolError("hyperframes_render", notes.join("\n\n") + "\n\n" + (e instanceof Error ? e.message : String(e)));
        }
      },
    });

    ctx.tool({
      name: "hyperframes.frames",
      description: "Extract still frames from a video into the chat project _out/frames as JPEG files. Pass times for single stills, or fps + start + duration for a numbered sequence a composition can play as motion.",
      input: z.object({
        path: z.string(),
        times: z.array(z.number()).min(1).max(12).optional(),
        fps: z.number().min(1).max(30).optional(),
        start: z.number().min(0).optional(),
        duration: z.number().positive().optional(),
        seq: z.string().optional(),
        width: z.number().int().positive().max(4096).optional(),
        ffmpeg: z.string().optional(),
      }),
      sideEffects: "write",
      idempotent: true,
      timeoutMs: 300000,
      async run(args, tool) {
        const ffmpeg = args.ffmpeg || firstExisting(knownFfmpeg());
        if (!ffmpeg)
          throw new ToolError("hyperframes_ffmpeg", "не нашла ffmpeg.exe. Передайте путь параметром ffmpeg.");
        const base = tool && tool.workspace ? tool.workspace : process.cwd();
        const src = isAbsolute(args.path) ? args.path : join(base, args.path);
        if (!existsSync(src))
          throw new ToolError("hyperframes_missing", `нет ${src}`);
        const root = tool && tool.workspace ? join(tool.workspace, "_out", "frames") : dirname(src);
        mkdirSync(root, { recursive: true });
        const scale = "scale=" + (args.width ?? 480) + ":-2";

        /* последовательность: ровный fps, имена seq_0001.jpg */
        if (args.fps) {
          const name = args.seq ?? "seq";
          const outDir = join(root, name);
          mkdirSync(outDir, { recursive: true });
          const pattern = join(outDir, "seq_%04d.jpg");
          const cmd = [
            "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
            "-ss", String(args.start ?? 0),
            "-t", String(args.duration ?? 10),
            "-i", src,
            "-vf", "fps=" + args.fps + "," + scale,
            "-q:v", "3",
            pattern,
          ];
          const r = await run(ffmpeg, cmd, outDir, 240_000);
          const files = readdirSync(outDir).filter((f) => f.startsWith("seq_")).sort();
          if (!files.length)
            throw new ToolError("hyperframes_frames", "ffmpeg не дал кадров: " + r.out.slice(-400));
          return { content: { dir: outDir, count: files.length, first: files[0], last: files[files.length - 1] } };
        }

        const times = args.times ?? [0];
        const files = [];
        const failed = [];
        for (const t of times) {
          const name = "f_" + String(t).replace(/[^0-9a-z]/gi, "_") + ".jpg";
          const dst = join(root, name);
          const r = await run(ffmpeg, ["-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", src, "-frames:v", "1", "-vf", scale, dst], root, 60_000);
          if (r.code === 0 && existsSync(dst))
            files.push(dst);
          else
            failed.push(`${t}: ${r.out.slice(-300)}`);
        }
        return { content: { dir: root, files, failed } };
      },
    });

    const html = (body) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": TAB_CSP, "cache-control": "no-store" } });
    ctx.http({ method: "GET", path: "/tab/updates", public: true, surface: "updates", handler: () => html(tabHtml()) });
    ctx.http({
      method: "GET",
      path: "/status",
      surface: "updates",
      access: "view",
      handler: async () => {
        try {
          return json(await status(true));
        }
        catch (e) {
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
          if (!remote.version || !remote.sha)
            return json({ error: "пустой ответ" }, 502);
          writeMark(dir, { version: remote.version, sha: remote.sha });
          return json({ ok: true, update: false, remote });
        }
        catch (e) {
          return json({ error: e instanceof Error ? e.message : "не сохранилось" }, 502);
        }
      },
    });

    const fail = (message, status = 400) => json({ error: { message } }, status);
    const folderOf = (slug) => {
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
            const thumb = thumbPath ? "data:image/jpeg;base64," + readFileSync(thumbPath).toString("base64") : "";
            return { slug, name: meta.id || meta.title || slug, width: meta.width, height: meta.height, hasVideo: Boolean(findVideo(folder)), thumb };
          });
          return json({ items });
        }
        catch (e) {
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
        if (url.searchParams.get("view") === "html")
          return json({ html: inlineAssets(folder, readFileSync(join(folder, "index.html"), "utf8")) });
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
        const body = await req.json();
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
          const result = await run(npm, ["install", "--prefix", prefix, "--no-fund", "--no-audit", "hyperframes@" + remote.version], prefix, 180_000);
          if (result.code !== 0) return fail(result.out.slice(-500) || "npm не установил пакет", 502);
          if (remote.sha) writeMark(dir, { version: remote.version, sha: remote.sha });
          return json({ ok: true, installed: installedVersion(prefix), remote });
        }
        catch (e) {
          return fail(e instanceof Error ? e.message : "не обновилось", 502);
        }
      },
    });
  },
});
//# sourceMappingURL=index.js.map