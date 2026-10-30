import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, ToolError, z } from "@sinty/sdk";
import { readMark, updateAvailable, writeMark, type Remote } from "./updates.js";

const TAB_CSP = ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"].join("; ");
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

function tabHtml(): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Hyperframes</title>
<style>
body{margin:0;font:14px/1.45 system-ui,sans-serif;color:#1d1d1f}
h1{font-size:16px;margin:0;padding:12px 16px;border-bottom:1px solid #e5e5ea}
p,button{margin:12px 16px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#d1242f;margin-right:6px}
.ok{color:#6e6e73}
button{font:inherit;cursor:pointer}
</style></head><body>
<h1>Hyperframes</h1>
<p id="state" class="ok">Проверяю обновления…</p>
<button type="button" id="seen" hidden>Отметить просмотренным</button>
<script>
const send = (op, extra) => parent.postMessage(Object.assign({ sinty: "tab/1", op }, extra || {}), "*");
let n = 0; const wait = new Map();
addEventListener("message", (e) => { const m = e.data || {}; if (m.sinty !== "tab/1") return; if (typeof m.id === "number" && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
function ask(op, path, body) { const id = ++n; return new Promise((ok) => { wait.set(id, ok); send(op, { id, path, body }); }); }
function show(data) {
  const el = document.getElementById("state");
  const btn = document.getElementById("seen");
  if (!data || data.error) { el.textContent = "Не удалось спросить GitHub или npm."; return; }
  if (data.update) {
    el.className = "";
    el.innerHTML = '<span class="dot"></span>Есть обновление: npm ' + data.remote.version + ", " + data.remote.title;
    btn.hidden = false;
  } else {
    el.className = "ok";
    el.textContent = "Обновлений нет. Сейчас npm " + data.remote.version + ".";
    btn.hidden = true;
  }
}
async function load() { const m = await ask("get", "/status"); show(m.data); }
document.getElementById("seen").onclick = async () => { await ask("post", "/seen", {}); await load(); };
load();
send("ready");
</script></body></html>`;
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

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  const chrome = playwrightChrome();
  const bins = toolBins();
  const env = {
    ...process.env,
    ...(bins.length ? { PATH: [...bins, process.env.PATH].filter(Boolean).join(";") } : {}),
    ...(chrome ? { PUPPETEER_EXECUTABLE_PATH: chrome, CHROME_PATH: chrome } : {}),
  };
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, shell: false, env });
    let out = "";
    const take = (buf: Buffer) => { out = (out + buf.toString("utf8")).slice(-8000); };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => { child.kill(); resolve({ code: 1, out: out + "\nостановлено по таймауту 3 минуты" }); }, 180_000);
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
      return { update: updateAvailable(seen, remote), seen, remote };
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
      description: "Run npx hyperframes render in hyperframes/<slug>. Uses the Playwright Chromium already on this machine. If FFmpeg, Python or ImageMagick is missing, call runtimes.install. Stops after 3 minutes.",
      input: z.object({ slug: z.string() }),
      sideEffects: "external",
      idempotent: false,
      async run(args) {
        if (!SLUG.test(args.slug)) throw new ToolError("hyperframes_slug", "slug: латиница через дефис");
        const project = join(ctx.paths.workspace, "hyperframes", args.slug);
        const bin = process.platform === "win32" ? "npx.cmd" : "npx";
        const result = await run(bin, ["--yes", "hyperframes", "render"], project);
        if (result.code !== 0) throw new ToolError("hyperframes_render", result.out || `код ${result.code}`);
        return { content: { dir: project, output: result.out } };
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
  },
});
