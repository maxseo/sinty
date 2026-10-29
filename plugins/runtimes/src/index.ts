import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, ToolError, z } from "@sinty/sdk";

const TAB_CSP = ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"].join("; ");

const PACKAGES = {
  ffmpeg: "Gyan.FFmpeg",
  python: "Python.Python.3.12",
  magick: "ImageMagick.ImageMagick",
} as const;

type Name = keyof typeof PACKAGES;

function playwrightChrome(): string | null {
  const root = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  try {
    const hits = readdirSync(root)
      .filter((name) => name.startsWith("chromium-"))
      .map((name) => join(root, name, "chrome-win64", "chrome.exe"))
      .filter((file) => existsSync(file));
    return hits.at(-1) ?? null;
  } catch {
    return null;
  }
}

function where(bin: string): Promise<string | null> {
  const cmd = process.platform === "win32" ? "where.exe" : "which";
  return new Promise((resolve) => {
    const child = spawn(cmd, [bin], { windowsHide: true });
    let out = "";
    child.stdout?.on("data", (buf: Buffer) => { out += buf.toString("utf8"); });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.split(/\r?\n/).find(Boolean) ?? null : null));
  });
}

function winget(id: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("winget", ["install", "--id", id, "-e", "--scope", "user", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"], { windowsHide: true, shell: true });
    let out = "";
    const take = (buf: Buffer) => { out = (out + buf.toString("utf8")).slice(-8000); };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => { child.kill(); resolve({ code: 1, out: out + "\nостановлено по таймауту 10 минут" }); }, 600_000);
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: 1, out: String(err) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
}

async function status() {
  const [ffmpeg, python, magick] = await Promise.all([where("ffmpeg"), where("python"), where("magick")]);
  const chrome = playwrightChrome();
  return {
    ffmpeg, python, magick, chrome,
    missing: [ffmpeg ? "" : "ffmpeg", python ? "" : "python", magick ? "" : "magick", chrome ? "" : "chrome"].filter(Boolean),
  };
}

function tabHtml(): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Программы</title>
<style>
body{margin:0;font:14px/1.45 system-ui,sans-serif;color:#1d1d1f}
h1{font-size:16px;margin:0;padding:12px 16px;border-bottom:1px solid #e5e5ea}
p,button{margin:12px 16px}
.miss{color:#9a3412}
button{font:inherit;cursor:pointer}
</style></head><body>
<h1>Программы</h1>
<p id="state">Проверяю…</p>
<button type="button" id="go">Установить недостающее</button>
<p id="log"></p>
<script>
const send = (op, extra) => parent.postMessage(Object.assign({ sinty: "tab/1", op }, extra || {}), "*");
let n = 0; const wait = new Map();
addEventListener("message", (e) => { const m = e.data || {}; if (m.sinty !== "tab/1") return; if (typeof m.id === "number" && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
function ask(op, path, body) { const id = ++n; return new Promise((ok) => { wait.set(id, ok); send(op, { id, path, body }); }); }
function line(s) {
  const bits = [];
  bits.push(s.ffmpeg ? "FFmpeg: есть" : "FFmpeg: нет");
  bits.push(s.python ? "Python: есть" : "Python: нет");
  bits.push(s.magick ? "ImageMagick: есть" : "ImageMagick: нет");
  bits.push(s.chrome ? "Chrome: Chromium Playwright" : "Chrome: нет");
  return bits.join(" · ");
}
async function load() {
  const m = await ask("get", "/status");
  const el = document.getElementById("state");
  if (!m.ok) { el.textContent = "Не проверилось"; return; }
  el.textContent = line(m.data);
  el.className = m.data.missing && m.data.missing.length ? "miss" : "";
  document.getElementById("go").hidden = !(m.data.missing || []).filter((x) => x !== "chrome").length;
}
document.getElementById("go").onclick = async () => {
  document.getElementById("log").textContent = "Ставлю через winget…";
  const m = await ask("post", "/install", { what: "all" });
  document.getElementById("log").textContent = m.ok ? "Готово. Новое окно терминала увидит их в PATH." : ((m.error && m.error.message) || "не установилось");
  await load();
};
load();
send("ready");
</script></body></html>`;
}

export default definePlugin({
  name: "runtimes",
  setup(ctx) {
    ctx.tool({
      name: "runtimes.status",
      description: "Paths for ffmpeg, python and magick on PATH, and the Playwright Chromium used by web.screenshot. missing lists what is absent.",
      input: z.object({}),
      sideEffects: "read",
      idempotent: true,
      async run() {
        return { content: await status() };
      },
    });
    ctx.tool({
      name: "runtimes.install",
      description: "Install ffmpeg, python, magick, or all, with winget for the current user. Chrome is not installed: HyperFrames uses the Playwright Chromium. A new terminal sees the new PATH.",
      input: z.object({ what: z.enum(["ffmpeg", "python", "magick", "all"]) }),
      sideEffects: "external",
      idempotent: true,
      async run(args) {
        if (process.platform !== "win32") throw new ToolError("runtimes_os", "установка через winget только на Windows");
        const names = (args.what === "all" ? ["ffmpeg", "python", "magick"] : [args.what]) as Name[];
        const installed: Record<string, string> = {};
        for (const name of names) {
          const result = await winget(PACKAGES[name]);
          if (result.code !== 0) throw new ToolError("runtimes_install", `${name}: ${result.out || result.code}`);
          installed[name] = PACKAGES[name];
        }
        return { content: { installed, status: await status() } };
      },
    });

    const page = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": TAB_CSP, "cache-control": "no-store" } });
    const json = (body: unknown, statusCode = 200) => new Response(JSON.stringify(body), { status: statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    ctx.http({ method: "GET", path: "/tab/setup", public: true, surface: "setup", handler: () => page(tabHtml()) });
    ctx.http({ method: "GET", path: "/status", surface: "setup", access: "view", handler: async () => json(await status()) });
    ctx.http({
      method: "POST",
      path: "/install",
      surface: "setup",
      access: "edit",
      handler: async (req) => {
        const body = (await req.json().catch(() => null)) as { what?: string } | null;
        const what = body?.what === "ffmpeg" || body?.what === "python" || body?.what === "magick" || body?.what === "all" ? body.what : "all";
        if (process.platform !== "win32") return json({ error: { message: "только Windows" } }, 400);
        try {
          const names = (what === "all" ? ["ffmpeg", "python", "magick"] : [what]) as Name[];
          for (const name of names) {
            const result = await winget(PACKAGES[name]);
            if (result.code !== 0) return json({ error: { message: `${name}: ${result.out || result.code}` } }, 400);
          }
          return json(await status());
        } catch (e) {
          return json({ error: { message: e instanceof Error ? e.message : "не установилось" } }, 400);
        }
      },
    });
  },
});
