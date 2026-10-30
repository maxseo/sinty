import { spawn } from "node:child_process";
import { join } from "node:path";
import { definePlugin, ToolError, z } from "@sinty/sdk";

const TAB_CSP = ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"].join("; ");

type Name = "ffmpeg" | "python" | "magick";

/** The plugin process does not receive LOCALAPPDATA. The install folder is Local\Sinty\app\plugins\<name>. */
function localAppData(): string {
  if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  return join(process.cwd(), "..", "..", "..", "..");
}

function userEnv(): NodeJS.ProcessEnv {
  const local = localAppData();
  const extra = join(local, "Microsoft", "WindowsApps");
  return {
    ...process.env,
    LOCALAPPDATA: local,
    PATH: [process.env.PATH, extra].filter(Boolean).join(";"),
    ProgramFiles: process.env.ProgramFiles ?? "C:\\Program Files",
  };
}

function scan(): Promise<{ ffmpeg: string; python: string; magick: string; chrome: string }> {
  const ps = join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
function first($name, $roots) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($r in $roots) {
    $hit = Get-ChildItem $r -Filter ($name + '.exe') -Recurse -Depth 5 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return ''
}
$local = $env:LOCALAPPDATA
$chrome = Get-ChildItem (Join-Path $local 'ms-playwright') -Filter chrome.exe -Recurse -Depth 4 -ErrorAction SilentlyContinue | Select-Object -First 1
$tools = Join-Path $local 'Sinty\tools'
@{ ffmpeg = first 'ffmpeg' @($tools); python = first 'python' @($tools, (Join-Path $local 'Programs\Python')); magick = first 'magick' @($tools); chrome = $(if ($chrome) { $chrome.FullName } else { '' }) } | ConvertTo-Json -Compress
`;
  return new Promise((resolve) => {
    const child = spawn(ps, ["-NoProfile", "-Command", script], { windowsHide: true, env: userEnv() });
    let out = "";
    child.stdout?.on("data", (buf: Buffer) => { out += buf.toString("utf8"); });
    child.on("error", () => resolve({ ffmpeg: "", python: "", magick: "", chrome: "" }));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out) as { ffmpeg?: string; python?: string; magick?: string; chrome?: string };
        resolve({ ffmpeg: parsed.ffmpeg ?? "", python: parsed.python ?? "", magick: parsed.magick ?? "", chrome: parsed.chrome ?? "" });
      } catch {
        resolve({ ffmpeg: "", python: "", magick: "", chrome: "" });
      }
    });
  });
}

function sys(name: string): string {
  return join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", name);
}

function run(bin: string, args: string[], ms: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true, env: userEnv() });
    let out = "";
    const take = (buf: Buffer) => { out = (out + buf.toString("utf8")).slice(-4000); };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => { child.kill(); resolve({ code: 1, out: out + "\nостановлено по таймауту" }); }, ms);
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: 1, out: String(err) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
}

async function download(url: string, dest: string): Promise<void> {
  const result = await run(sys("curl.exe"), ["-L", "--fail", "-o", dest, url], 600_000);
  if (result.code !== 0) throw new Error(result.out || "не скачалось");
}

async function installTool(name: Name): Promise<void> {
  const tools = join(localAppData(), "Sinty", "tools");
  const made = await run(sys("WindowsPowerShell\\v1.0\\powershell.exe"), ["-NoProfile", "-Command", `New-Item -ItemType Directory -Force -Path '${tools}' | Out-Null`], 30_000);
  if (made.code !== 0) throw new Error(made.out || "не создалась папка");
  if (name === "ffmpeg") {
    const zip = join(tools, "ffmpeg.zip");
    await download("https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip", zip);
    const unpacked = await run(sys("tar.exe"), ["-xf", zip, "-C", tools], 180_000);
    if (unpacked.code !== 0) throw new Error(unpacked.out || "ffmpeg не распаковался");
    return;
  }
  if (name === "python") {
    const exe = join(tools, "python-installer.exe");
    await download("https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe", exe);
    const dir = join(tools, "python");
    const installed = await run(exe, ["/quiet", "InstallAllUsers=0", `TargetDir=${dir}`, "PrependPath=0", "Include_test=0"], 600_000);
    if (installed.code !== 0) throw new Error(installed.out || "python не установился");
    return;
  }
  const seven = join(tools, "7zr.exe");
  await download("https://www.7-zip.org/a/7zr.exe", seven);
  const archive = join(tools, "magick.7z");
  await download("https://github.com/ImageMagick/ImageMagick/releases/download/7.1.2-34/ImageMagick-7.1.2-34-portable-Q16-x64.7z", archive);
  const unpacked = await run(seven, ["x", archive, `-o${join(tools, "magick")}`, "-y"], 180_000);
  if (unpacked.code !== 0) throw new Error(unpacked.out || "ImageMagick не распаковался");
}

async function status() {
  const found = await scan();
  const ffmpeg = found.ffmpeg || null;
  const python = found.python || null;
  const magick = found.magick || null;
  const chrome = found.chrome || null;
  return {
    ffmpeg, python, magick, chrome,
    missing: [ffmpeg ? "" : "ffmpeg", python ? "" : "python", magick ? "" : "magick"].filter(Boolean),
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
  bits.push(s.chrome ? "Chrome: есть" : "Chrome: нет");
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
  document.getElementById("log").textContent = "Скачиваю и распаковываю. Это несколько минут.";
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
      description: "Download ffmpeg, python, magick, or all into %LOCALAPPDATA%\\Sinty\\tools. Chrome is not installed: HyperFrames uses the Playwright Chromium.",
      input: z.object({ what: z.enum(["ffmpeg", "python", "magick", "all"]) }),
      sideEffects: "external",
      idempotent: true,
      async run(args) {
        if (process.platform !== "win32") throw new ToolError("runtimes_os", "установка только на Windows");
        const names = (args.what === "all" ? ["ffmpeg", "python", "magick"] : [args.what]) as Name[];
        const installed: string[] = [];
        for (const name of names) {
          try {
            await installTool(name);
          } catch (e) {
            throw new ToolError("runtimes_install", `${name}: ${e instanceof Error ? e.message : "не установилось"}`);
          }
          installed.push(name);
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
            try {
              await installTool(name);
            } catch (e) {
              return json({ error: { message: `${name}: ${e instanceof Error ? e.message : "не установилось"}` } }, 400);
            }
          }
          return json(await status());
        } catch (e) {
          return json({ error: { message: e instanceof Error ? e.message : "не установилось" } }, 400);
        }
      },
    });
  },
});
