import { spawn } from "node:child_process";
import { definePlugin, ToolError, z } from "@sinty/sdk";
import { isAbsolute, relative, resolve } from "node:path";

const TAB_CSP = ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"].join("; ");
const COMMANDS = ["open", "context", "capture", "check", "export", "probe", "grab", "transcribe", "filmstrip", "waveform", "listen", "fonts", "logs", "screenshot", "window", "job"] as const;
const LONG = new Set(["export", "transcribe", "listen", "grab", "generate"]);

function inside(root: string, target: string): string {
  const abs = resolve(root, target);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new ToolError("diffusion_path", "путь снаружи рабочей папки");
  return abs;
}

function where(bin: string): Promise<string | null> {
  const cmd = process.platform === "win32" ? "where.exe" : "which";
  return new Promise((resolvePath) => {
    const child = spawn(cmd, [bin], { windowsHide: true });
    let out = "";
    child.stdout?.on("data", (buf: Buffer) => { out += buf.toString("utf8"); });
    child.on("error", () => resolvePath(null));
    child.on("close", (code) => resolvePath(code === 0 ? out.split(/\r?\n/).find(Boolean) ?? null : null));
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
<style>body{margin:0;font:14px/1.45 system-ui,sans-serif;color:#1d1d1f}h1{font-size:16px;margin:0;padding:12px 16px;border-bottom:1px solid #e5e5ea}p{margin:12px 16px}.miss{color:#9a3412}</style></head><body>
<h1>Diffusion Studio</h1>
<p id="state">Проверяю…</p>
<script>
const send = (op, extra) => parent.postMessage(Object.assign({ sinty: "tab/1", op }, extra || {}), "*");
let n = 0; const wait = new Map();
addEventListener("message", (e) => { const m = e.data || {}; if (m.sinty !== "tab/1") return; if (typeof m.id === "number" && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
function ask(op, path) { const id = ++n; return new Promise((ok) => { wait.set(id, ok); send(op, { id, path }); }); }
ask("get", "/status").then((m) => {
  const el = document.getElementById("state");
  if (!m.ok) { el.textContent = "Не проверилось"; return; }
  const d = m.data;
  el.className = d.cli ? "" : "miss";
  el.textContent = d.cli ? "Команда diffusion найдена." : "Команды diffusion нет. Поставьте приложение Diffusion Studio: в нём эта команда и редактор.";
  if (d.release) el.textContent += " Последний релиз на GitHub: " + d.release + ".";
});
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
      return { cli, release, app: "https://github.com/diffusionstudio/editor" };
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
