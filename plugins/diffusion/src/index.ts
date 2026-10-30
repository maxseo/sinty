import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { definePlugin, ToolError, z } from "@sinty/sdk";
import { isAbsolute, join, relative, resolve } from "node:path";

const TAB_CSP = ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"].join("; ");
const COMMANDS = ["open", "context", "capture", "check", "export", "probe", "grab", "transcribe", "filmstrip", "waveform", "listen", "fonts", "logs", "screenshot", "window", "job"] as const;
const LONG = new Set(["export", "transcribe", "listen", "grab", "generate"]);

function inside(root: string, target: string): string {
  const abs = resolve(root, target);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new ToolError("diffusion_path", "путь снаружи рабочей папки");
  return abs;
}

function localAppData(): string {
  return process.env.LOCALAPPDATA || join(process.cwd(), "..", "..", "..", "..");
}

function where(bin: string): Promise<string | null> {
  const ps = join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `Get-Command ${bin} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source; Get-ChildItem (Join-Path $env:LOCALAPPDATA 'DiffusionStudio') -Include diffusion.exe,diffusion.cmd,dapi.exe,dapi.cmd -Recurse -Depth 5 -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName`;
  return new Promise((resolvePath) => {
    const child = spawn(ps, ["-NoProfile", "-Command", script], { windowsHide: true, env: { ...process.env, LOCALAPPDATA: localAppData() } });
    let out = "";
    child.stdout?.on("data", (buf: Buffer) => { out += buf.toString("utf8"); });
    child.on("error", () => resolvePath(null));
    child.on("close", () => resolvePath(out.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null));
  });
}

function exec(bin: string, args: string[], ms: number): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(bin, args, { windowsHide: true });
    let out = "";
    const take = (buf: Buffer) => { out = (out + buf.toString("utf8")).slice(-4000); };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => { child.kill(); done({ code: 1, out: out + "\nтаймаут" }); }, ms);
    child.on("error", (e) => { clearTimeout(timer); done({ code: 1, out: String(e) }); });
    child.on("close", (code) => { clearTimeout(timer); done({ code: code ?? 1, out }); });
  });
}

function run(bin: string, args: string[], cwd: string, ms: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(bin, args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout?.on("data", (buf: Buffer) => { out = (out + buf.toString("utf8")).slice(-12000); });
    child.stderr?.on("data", (buf: Buffer) => { err = (err + buf.toString("utf8")).slice(-4000); });
    const timer = setTimeout(() => { child.kill(); done({ code: 1, out, err: err + "\nостановлено по таймауту" }); }, ms);
    child.on("error", (e) => { clearTimeout(timer); done({ code: 1, out, err: String(e) }); });
    child.on("close", (code) => { clearTimeout(timer); done({ code: code ?? 1, out, err }); });
  });
}

function tabHtml(): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Diffusion</title>
<style>body{margin:0;font:14px/1.45 system-ui,sans-serif;color:#1d1d1f}h1{font-size:16px;margin:0;padding:12px 16px;border-bottom:1px solid #e5e5ea}p,button{margin:12px 16px}.miss{color:#9a3412}button{font:inherit;cursor:pointer}</style></head><body>
<h1>Diffusion Studio</h1>
<p id="state">Проверяю…</p>
<button type="button" id="open" hidden>Открыть редактор</button>
<button type="button" id="go" hidden>Установить приложение</button>
<p id="log"></p>
<script>
const send = (op, extra) => parent.postMessage(Object.assign({ sinty: "tab/1", op }, extra || {}), "*");
let n = 0; const wait = new Map();
addEventListener("message", (e) => { const m = e.data || {}; if (m.sinty !== "tab/1") return; if (typeof m.id === "number" && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
function ask(op, path, body) { const id = ++n; return new Promise((ok) => { wait.set(id, ok); send(op, { id, path, body }); }); }
async function load() {
  const m = await ask("get", "/status");
  const el = document.getElementById("state");
  if (!m.ok) { el.textContent = "Не проверилось"; return; }
  const d = m.data;
  el.className = d.app ? "" : "miss";
  el.textContent = d.app ? "Редактор установлен. Окно само не открывается." : "Редактор не установлен.";
  if (d.release) el.textContent += " Релиз на GitHub: " + d.release + ".";
  document.getElementById("open").hidden = !d.app;
  document.getElementById("go").hidden = !!d.app;
}
document.getElementById("open").onclick = async () => {
  const m = await ask("post", "/open", {});
  document.getElementById("log").textContent = m.ok ? "Окно редактора должно появиться на рабочем столе." : ((m.error && m.error.message) || "не открылось");
};
document.getElementById("go").onclick = async () => {
  document.getElementById("log").textContent = "Скачиваю установщик и запускаю его. Это несколько минут.";
  const m = await ask("post", "/install", {});
  document.getElementById("log").textContent = m.ok ? "Установщик завершился. Если команда всё ещё не видна, откройте приложение один раз." : ((m.error && m.error.message) || "не установилось");
  await load();
};
load();
send("ready");
</script></body></html>`;
}

export default definePlugin({
  name: "diffusion",
  setup(ctx) {
    const fetchPublic = (url: string, init?: { headers?: Record<string, string> }) => ctx.net.public.fetch(url, init);

    async function status() {
      const cli = (await where("diffusion")) ?? (await where("dapi"));
      let release = "";
      try {
        const res = await fetchPublic("https://api.github.com/repos/diffusionstudio/editor/releases/latest", {
          headers: { accept: "application/vnd.github+json", "user-agent": "sinty-diffusion" },
        });
        if (res.ok) {
          const body = (await res.json()) as { tag_name?: string };
          release = body.tag_name ?? "";
        }
      } catch {
        release = "";
      }
      const app = join(localAppData(), "DiffusionStudio", "Diffusion Studio.exe");
      const exists = await new Promise<boolean>((ok) => {
        const ps = join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const child = spawn(ps, ["-NoProfile", "-Command", `if (Test-Path -LiteralPath '${app.replaceAll("'", "''")}') { 'yes' }`], { windowsHide: true });
        let out = "";
        child.stdout?.on("data", (buf: Buffer) => { out += buf.toString("utf8"); });
        child.on("error", () => ok(false));
        child.on("close", () => ok(out.includes("yes")));
      });
      return { cli, app: exists ? app : null, release, page: "https://github.com/diffusionstudio/editor" };
    }

    async function call(command: string, args: string[]) {
      const cli = (await where("diffusion")) ?? (await where("dapi"));
      if (!cli) throw new ToolError("diffusion_missing", "Нет команды diffusion. Поставьте приложение Diffusion Studio с GitHub, оно добавляет эту команду.");
      const safe = args.map((arg) => {
        if (arg.length > 500 || /[\r\n]/.test(arg)) throw new ToolError("diffusion_arg", "слишком длинный аргумент");
        if (arg.startsWith("-") || /^https?:\/\//i.test(arg)) return arg;
        if (command === "open" || /[/\\]/.test(arg) || arg.startsWith(".")) return inside(ctx.paths.workspace, arg);
        return arg;
      });
      const result = await run(cli, [command, ...safe], ctx.paths.workspace, LONG.has(command) ? 600_000 : 180_000);
      if (result.code !== 0) throw new ToolError("diffusion_command", result.err || result.out || `код ${result.code}`);
      return { command, output: result.out };
    }

    ctx.tool({
      name: "diffusion.status",
      description: "Path of the diffusion command, or null when the desktop app is not installed. Also the latest GitHub release tag of diffusionstudio/editor.",
      input: z.object({}),
      sideEffects: "read",
      idempotent: true,
      async run() {
        return { content: await status() };
      },
    });

    ctx.tool({
      name: "diffusion.run",
      description: "One Diffusion Studio command. The project is a folder of Solid JSX; write those files with fs.write, then diffusion open on that folder. Commands: open, context, capture, check, export, probe, grab, transcribe, filmstrip, waveform, listen, fonts, logs, screenshot, window, job. Paths stay inside the workspace. The desktop app must be installed.",
      input: z.object({ command: z.enum(COMMANDS), args: z.array(z.string()).max(20).optional() }),
      sideEffects: "external",
      idempotent: false,
      async run(input) {
        return { content: await call(input.command, input.args ?? []) };
      },
    });

    ctx.tool({
      name: "diffusion.generate",
      description: "diffusion generate: make an image, clip, music or voice through the Diffusion Studio account. This spends credits. args are the CLI flags.",
      input: z.object({ args: z.array(z.string()).max(20) }),
      sideEffects: "external",
      idempotent: false,
      async run(input) {
        return { content: await call("generate", input.args) };
      },
    });

    const page = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": TAB_CSP, "cache-control": "no-store" } });
    const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    ctx.http({ method: "GET", path: "/tab/status", public: true, surface: "status", handler: () => page(tabHtml()) });
    ctx.http({
      method: "POST",
      path: "/open",
      surface: "status",
      access: "edit",
      handler: async () => {
        const current = await status();
        if (!current.app) return json({ error: { message: "редактор не установлен" } }, 400);
        const child = spawn(current.app, [], { detached: true, stdio: "ignore", windowsHide: false });
        child.unref();
        return json({ opened: current.app });
      },
    });
    ctx.http({
      method: "POST",
      path: "/install",
      surface: "status",
      access: "edit",
      handler: async () => {
        if (process.platform !== "win32") return json({ error: { message: "установщик есть для Windows x64" } }, 400);
        try {
          mkdirSync(ctx.paths.data, { recursive: true });
          const file = join(ctx.paths.data, "Diffusion-Studio-x64-Setup.exe");
          const curl = join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "curl.exe");
          const downloaded = await exec(curl, ["-L", "--fail", "-o", file, "https://github.com/diffusionstudio/editor/releases/latest/download/Diffusion-Studio-x64-Setup.exe"], 600_000);
          if (downloaded.code !== 0) return json({ error: { message: downloaded.out || "не скачалось" } }, 400);
          const installed = await exec(file, ["--silent"], 600_000);
          if (installed.code !== 0) return json({ error: { message: installed.out || "установщик завершился с ошибкой" } }, 400);
          return json(await status());
        } catch (e) {
          return json({ error: { message: e instanceof Error ? e.message : "не установилось" } }, 400);
        }
      },
    });
    ctx.http({
      method: "GET",
      path: "/status",
      surface: "status",
      access: "view",
      handler: async () => {
        try {
          return json(await status());
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "не проверилось" }, 502);
        }
      },
    });
  },
});
