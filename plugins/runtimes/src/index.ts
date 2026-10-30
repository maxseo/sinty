import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { definePlugin, ToolError, z } from "@sinty/sdk";

const TAB_CSP = ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"].join("; ");

type Name = "ffmpeg" | "python" | "magick";

const LABELS: Record<Name, string> = { ffmpeg: "FFmpeg", python: "Python", magick: "ImageMagick" };
/** Same essentials build gyan.dev serves, from the GitHub file host. gyan.dev itself sends about 120 KB/s. */
const FFMPEG_ZIP = "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip";

/** The plugin process does not receive LOCALAPPDATA. The install folder is Local\Sinty\app\plugins\<name>. */
function localAppData(): string {
  if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  return join(process.cwd(), "..", "..", "..", "..");
}

function toolsDir(): string {
  return join(localAppData(), "Sinty", "tools");
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
  const ps = powershell();
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
function first($name, $roots) {
  foreach ($r in $roots) {
    if (-not (Test-Path -LiteralPath $r)) { continue }
    $hit = Get-ChildItem -LiteralPath $r -Filter ($name + '.exe') -Recurse -Depth 5 -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '\\\\WindowsApps\\\\' -and $_.Length -gt 0 } |
      Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -notmatch '\\\\WindowsApps\\\\') { return $cmd.Source }
  return ''
}
$local = $env:LOCALAPPDATA
$chrome = Get-ChildItem (Join-Path $local 'ms-playwright') -Filter chrome.exe -Recurse -Depth 4 -ErrorAction SilentlyContinue | Select-Object -First 1
$tools = Join-Path $local 'Sinty\\tools'
@{ ffmpeg = first 'ffmpeg' @($tools); python = first 'python' @($tools, (Join-Path $local 'Programs\\Python')); magick = first 'magick' @($tools); chrome = $(if ($chrome) { $chrome.FullName } else { '' }) } | ConvertTo-Json -Compress
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

function powershell(): string {
  return join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function sys(name: string): string {
  return join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", name);
}

function run(bin: string, args: string[], ms: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true, env: userEnv() });
    let out = "";
    let err = "";
    child.stdout?.on("data", (buf: Buffer) => { out = (out + buf.toString("utf8")).slice(-4000); });
    child.stderr?.on("data", (buf: Buffer) => { err = (err + buf.toString("utf8")).slice(-4000); });
    const timer = setTimeout(() => { child.kill(); resolve({ code: 1, out, err: err + "\nостановлено по таймауту" }); }, ms);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, out, err: String(e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out, err }); });
  });
}

function tail(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.slice(-400) || "не установилось";
}

function q(path: string): string {
  return `'${path.replace(/'/g, "''")}'`;
}

/** The plugin process may not write outside its grant. curl, tar and PowerShell are children and may. Encoded so -Command does not eat quotes. */
function ps(script: string, ms = 30_000): Promise<{ code: number; out: string; err: string }> {
  const body = `$ProgressPreference = 'SilentlyContinue'\ntry {\n${script}\n} catch {\n  Write-Output $_.Exception.Message\n  exit 1\n}`;
  const encoded = Buffer.from(body, "utf16le").toString("base64");
  return run(powershell(), ["-NoProfile", "-EncodedCommand", encoded], ms);
}

async function contentLength(url: string): Promise<number> {
  const head = await run(sys("curl.exe"), ["-sI", "-L", "--fail", url], 30_000);
  const found = [...head.out.matchAll(/content-length:\s*(\d+)/gi)];
  const last = found.at(-1);
  return last ? Number(last[1]) : 0;
}

/** One PowerShell writes the growing file size. The plugin process is not allowed to stat this folder. */
function watchSize(dest: string, onSize: (bytes: number) => void): { stop: () => void } {
  const script = `$ProgressPreference = 'SilentlyContinue'\n$p = ${q(dest)}\nwhile ($true) {\n  if (Test-Path -LiteralPath $p) { (Get-Item -LiteralPath $p).Length } else { 0 }\n  Start-Sleep -Milliseconds 400\n}`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const child = spawn(powershell(), ["-NoProfile", "-EncodedCommand", encoded], { windowsHide: true, env: userEnv() });
  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    const last = lines.map((line) => line.trim()).filter(Boolean).pop();
    const n = last ? Number(last) : NaN;
    if (Number.isFinite(n)) onSize(n);
  });
  return { stop: () => { child.kill(); } };
}

async function download(url: string, dest: string, label: string): Promise<void> {
  const total = await contentLength(url);
  job = { ...job, step: `Скачиваю ${label}`, received: 0, total, error: "" };
  const watch = watchSize(dest, (received) => { job = { ...job, received, total }; });
  try {
    const result = await run(sys("curl.exe"), ["-L", "--fail", "--retry", "3", "--retry-delay", "2", "-o", dest, url], 600_000);
    const size = await ps(`$i = Get-Item -LiteralPath ${q(dest)} -ErrorAction SilentlyContinue; if ($i) { $i.Length }`);
    const bytes = Number(size.out.trim().split(/\r?\n/).pop());
    if (result.code !== 0 || !Number.isFinite(bytes) || bytes < 1000) throw new Error(tail(result.err || "не скачалось"));
    job = { ...job, received: bytes, total: total || bytes };
  } finally {
    watch.stop();
  }
}

async function exeDir(root: string, name: string): Promise<string> {
  const script = `
$hit = Get-ChildItem -LiteralPath '${root.replace(/'/g, "''")}' -Filter '${name}.exe' -Recurse -Depth 5 -ErrorAction SilentlyContinue |
  Where-Object { $_.Length -gt 0 } | Select-Object -First 1
if ($hit) { $hit.DirectoryName }
`;
  const result = await run(powershell(), ["-NoProfile", "-Command", script], 60_000);
  const dir = result.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() ?? "";
  if (result.code !== 0 || !dir) throw new Error(tail(result.err || `${name}.exe не найден после установки`));
  return dir;
}

/** New terminals see the bins. The user PATH is separate from the system PATH. */
async function addToUserPath(dirs: string[]): Promise<void> {
  if (!dirs.length) return;
  const list = dirs.map((dir) => q(dir)).join(", ");
  const script = `
$dirs = @(${list}) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$cur = [Environment]::GetEnvironmentVariable('Path', 'User')
$keep = @()
if (-not @($dirs).Count) { throw 'папка программы не найдена' }
if ($cur) { $keep = @($cur -split ';' | Where-Object { $_ -and (@($dirs) -notcontains $_) }) }
$next = (@($dirs) + $keep) -join ';'
[Environment]::SetEnvironmentVariable('Path', $next, 'User')
$now = @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | ForEach-Object { $_.TrimEnd('\\') })
foreach ($d in @($dirs)) {
  $want = $d.TrimEnd('\\')
  $found = $false
  foreach ($p in $now) { if ($p -ieq $want) { $found = $true } }
  if (-not $found) { throw 'PATH не записался' }
}
`;
  const result = await ps(script);
  if (result.code !== 0) throw new Error(tail(result.err || result.out || "PATH не обновился"));
}

/** A stable folder name. ffmpeg.exe needs the DLLs beside it, so this is a junction, not a copy. */
async function linkBin(name: string, dir: string): Promise<void> {
  const link = join(toolsDir(), name);
  if (link.toLowerCase() === dir.toLowerCase()) return;
  const result = await ps(`$l = ${q(link)}; $d = ${q(dir)}; if (Test-Path -LiteralPath $l) { Remove-Item -LiteralPath $l -Force }; New-Item -ItemType Junction -Path $l -Target $d | Out-Null`);
  if (result.code !== 0) throw new Error(tail(result.err || result.out || "не создалась ссылка"));
}

async function installTool(name: Name, step: (text: string) => void): Promise<string> {
  const tools = toolsDir();
  const made = await ps(`New-Item -ItemType Directory -Force -Path ${q(tools)} | Out-Null`);
  if (made.code !== 0) throw new Error(tail(made.err || made.out || "не создалась папка"));
  if (name === "ffmpeg") {
    const zip = join(tools, "ffmpeg.zip");
    await download(FFMPEG_ZIP, zip, "FFmpeg");
    step("Распаковываю FFmpeg");
    const unpacked = await run(sys("tar.exe"), ["-xf", zip, "-C", tools], 300_000);
    if (unpacked.code !== 0) throw new Error(tail(unpacked.err || unpacked.out || "ffmpeg не распаковался"));
    await ps(`Remove-Item -LiteralPath ${q(zip)} -Force`);
    const dir = await exeDir(tools, "ffmpeg");
    await linkBin("ffmpeg", dir);
    return dir;
  }
  if (name === "python") {
    const exe = join(tools, "python-installer.exe");
    await download("https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe", exe, "Python");
    const dir = join(tools, "python");
    await ps(`$d = ${q(dir)}; if ((Test-Path -LiteralPath $d) -and -not (Test-Path -LiteralPath (Join-Path $d 'python.exe'))) { Remove-Item -LiteralPath $d -Recurse -Force }`);
    await ps(`Unblock-File -LiteralPath ${q(exe)}`);
    step("Устанавливаю Python");
    const log = join(tools, "python-install.log");
    const installed = await run(exe, ["/quiet", "InstallAllUsers=0", `TargetDir=${dir}`, "PrependPath=0", "Include_test=0", "Include_pip=1", "Shortcuts=0", "/log", log], 600_000);
    const exeThere = await ps(`if (Test-Path -LiteralPath ${q(join(dir, "python.exe"))}) { 'yes' }`);
    if (installed.code !== 0 || !exeThere.out.includes("yes")) {
      const note = await ps(`if (Test-Path -LiteralPath ${q(log)}) { Get-Content -LiteralPath ${q(log)} -Tail 15 }`);
      throw new Error(tail(note.out || installed.err || installed.out || "python не установился"));
    }
    await ps(`Remove-Item -LiteralPath ${q(exe)} -Force`);
    return dir;
  }
  const seven = join(tools, "7zr.exe");
  const sevenSize = await ps(`$i = Get-Item -LiteralPath ${q(seven)} -ErrorAction SilentlyContinue; if ($i) { $i.Length } else { 0 }`);
  if (Number(sevenSize.out.trim().split(/\r?\n/).pop()) < 1000) await download("https://www.7-zip.org/a/7zr.exe", seven, "7-Zip");
  const archive = join(tools, "magick.7z");
  await download("https://github.com/ImageMagick/ImageMagick/releases/download/7.1.2-34/ImageMagick-7.1.2-34-portable-Q16-x64.7z", archive, "ImageMagick");
  step("Распаковываю ImageMagick");
  const dest = join(tools, "magick");
  const unpacked = await run(seven, ["x", archive, `-o${dest}`, "-y"], 180_000);
  if (unpacked.code !== 0) throw new Error(tail(unpacked.err || unpacked.out || "ImageMagick не распаковался"));
  await ps(`Remove-Item -LiteralPath ${q(archive)} -Force`);
  return exeDir(dest, "magick");
}

type Job = { running: boolean; what: string; step: string; error: string; received: number; total: number };

let job: Job = { running: false, what: "", step: "", error: "", received: 0, total: 0 };
let queue: Promise<void> = Promise.resolve();

function binsOf(found: { ffmpeg: string; python: string; magick: string }, names: Name[]): string[] {
  const dirs: string[] = [];
  for (const name of names) {
    const file = found[name];
    if (!file) continue;
    dirs.push(dirname(file));
    if (name === "python") dirs.push(join(dirname(file), "Scripts"));
    if (name === "ffmpeg") dirs.push(join(toolsDir(), "ffmpeg"));
  }
  return dirs;
}

function wanted(what: string): Name[] {
  if (what === "ffmpeg" || what === "python" || what === "magick") return [what];
  return ["ffmpeg", "python", "magick"];
}

/**
 * The tab must answer in two minutes, so the download continues after the HTTP response.
 * Clicks line up: a second package waits until the first one finishes.
 */
function startInstall(what: string): Promise<string> {
  const run = queue.then(() => installNames(what));
  queue = run.then(() => undefined, () => undefined);
  return run;
}

async function installNames(what: string): Promise<string> {
  const names = wanted(what);
  job = { running: true, what, step: "Проверяю, чего не хватает", error: "", received: 0, total: 0 };
  const bins: string[] = [];
  try {
    const found = await scan();
    const todo = names.filter((name) => !found[name]);
    if (!todo.length) {
      if (found.ffmpeg && names.includes("ffmpeg")) await linkBin("ffmpeg", dirname(found.ffmpeg));
      job = { running: true, what, step: "Добавляю в PATH", error: "", received: 0, total: 0 };
      await addToUserPath(binsOf(found, names));
      job = { running: false, what, step: "Уже стоят", error: "", received: 0, total: 0 };
      return "";
    }
    for (const name of todo) {
      const dir = await installTool(name, (step) => { job = { ...job, running: true, what, step, error: "" }; });
        bins.push(dir);
        if (name === "python") bins.push(join(dir, "Scripts"));
        if (name === "ffmpeg") bins.push(join(toolsDir(), "ffmpeg"));
    }
    job = { ...job, running: true, what, step: "Добавляю в PATH", error: "", received: 0, total: 0 };
    await addToUserPath(bins);
    job = { running: false, what, step: "Готово. Новое окно терминала их увидит.", error: "", received: 0, total: 0 };
    return "";
  } catch (err) {
    if (bins.length) await addToUserPath(bins).catch(() => undefined);
    const message = err instanceof Error ? err.message : "не установилось";
    job = { running: false, what, step: "", error: message, received: job.received, total: job.total };
    return message;
  }
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
    job,
  };
}

function tabHtml(): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Программы</title>
<style>
body{margin:0;font:14px/1.45 system-ui,sans-serif;color:#1d1d1f}
h1{font-size:16px;margin:0;padding:12px 16px;border-bottom:1px solid #e5e5ea}
ul{list-style:none;margin:0;padding:8px 0}
li{display:flex;align-items:center;gap:12px;padding:8px 16px}
.name{width:140px}
.ok{color:#166534}
.miss{color:#9a3412}
.note{color:#6b7280}
button{font:inherit;cursor:pointer}
#all{margin:4px 16px 12px}
#log{margin:0 16px 8px;white-space:pre-wrap}
#prog{margin:0 16px 16px;display:flex;align-items:center;gap:10px}
#meter{width:280px;height:16px}
#pct{color:#374151}
</style></head><body>
<h1>Программы</h1>
<ul id="rows"></ul>
<button type="button" id="all">Установить все</button>
<p id="log"></p>
<p id="prog" hidden><progress id="meter" max="1" value="0"></progress><span id="pct"></span></p>
<script>
const send = (op, extra) => parent.postMessage(Object.assign({ sinty: "tab/1", op }, extra || {}), "*");
let n = 0; const wait = new Map();
addEventListener("message", (e) => { const m = e.data || {}; if (m.sinty !== "tab/1") return; if (typeof m.id === "number" && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
function ask(op, path, body) { const id = ++n; return new Promise((ok) => { wait.set(id, ok); send(op, { id, path, body }); }); }
const ROWS = [["ffmpeg","FFmpeg"],["python","Python"],["magick","ImageMagick"],["chrome","Chrome"]];
let timer = 0;
function paint(s) {
  const box = document.getElementById("rows");
  box.replaceChildren();
  const busy = !!(s.job && s.job.running);
  for (const pair of ROWS) {
    const key = pair[0], label = pair[1];
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = label;
    const st = document.createElement("span");
    st.className = s[key] ? "ok" : "miss";
    st.textContent = s[key] ? "есть" : "нет";
    li.append(name, st);
    if (key !== "chrome" && !s[key]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Установить";
      b.disabled = busy;
      b.onclick = () => install(key);
      li.append(b);
    }
    if (key === "chrome" && !s[key]) {
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = "Chromium Playwright, отдельной установки нет";
      li.append(note);
    }
    box.append(li);
  }
  const missing = (s.missing || []).length;
  const all = document.getElementById("all");
  all.hidden = !missing;
  all.disabled = busy;
  const log = document.getElementById("log");
  if (s.job && s.job.error) log.textContent = s.job.error;
  else if (s.job && (s.job.running || s.job.step)) log.textContent = s.job.step;
  const prog = document.getElementById("prog");
  const meter = document.getElementById("meter");
  const pct = document.getElementById("pct");
  const downloading = busy && s.job && /^Скачиваю/.test(s.job.step || "");
  prog.hidden = !downloading;
  if (downloading) {
    const got = s.job.received || 0;
    const total = s.job.total || 0;
    const mb = (n) => (n / 1048576).toFixed(1).replace(".", ",");
    if (total > 0) {
      meter.max = total;
      meter.value = Math.min(got, total);
      pct.textContent = mb(got) + " МБ из " + mb(total) + " МБ";
    } else {
      meter.removeAttribute("value");
      pct.textContent = got ? mb(got) + " МБ" : "";
    }
  }
  if (busy) {
    if (!timer) timer = setTimeout(() => { timer = 0; load(); }, downloading ? 500 : 2000);
  }
}
async function load() {
  const m = await ask("get", "/status");
  if (!m.ok) { document.getElementById("log").textContent = "Не проверилось"; return; }
  paint(m.data);
}
async function install(what) {
  document.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  document.getElementById("log").textContent = "Запускаю. Скачивание идёт само и занимает несколько минут.";
  const m = await ask("post", "/install", { what: what });
  if (!m.ok) document.getElementById("log").textContent = (m.error && m.error.message) || "не установилось";
  await load();
}
document.getElementById("all").onclick = () => install("all");
load();
send("ready");
</script></body></html>`;
}

export default definePlugin({
  name: "runtimes",
  setup(ctx) {
    ctx.tool({
      name: "runtimes.status",
      description: "Paths for ffmpeg, python and magick, and the Playwright Chromium used by web.screenshot. missing lists what is absent. job says whether an install is still running.",
      input: z.object({}),
      sideEffects: "read",
      idempotent: true,
      async run() {
        return { content: await status() };
      },
    });
    ctx.tool({
      name: "runtimes.install",
      description: "Download ffmpeg, python, magick, or all that are missing into %LOCALAPPDATA%\\Sinty\\tools and add them to the user PATH. Chrome is not installed: HyperFrames uses the Playwright Chromium. Skips a program that is already present.",
      input: z.object({ what: z.enum(["ffmpeg", "python", "magick", "all"]) }),
      sideEffects: "external",
      idempotent: true,
      timeoutMs: 1_200_000,
      async run(args) {
        if (process.platform !== "win32") throw new ToolError("runtimes_os", "установка только на Windows");
        const message = await startInstall(args.what);
        if (message) throw new ToolError("runtimes_install", message);
        return { content: await status() };
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
        startInstall(what);
        return json({ started: true, ...(await status()) });
      },
    });
  },
});
