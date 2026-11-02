import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { definePlugin, ToolError, z } from "@sinty/sdk";
import { acceptFromEditor, callTool, cloudCall, createFilm, listFilms, noteChange, readMedia, takeInbox, writeMedia } from "./host.js";

const COMMANDS = ["open", "context", "capture", "check", "export", "probe", "grab", "transcribe", "filmstrip", "waveform", "listen", "fonts", "logs", "screenshot", "window", "job", "generate"] as const;
const LONG = new Set(["export", "transcribe", "listen", "grab", "generate"]);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function cors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  headers.set("cross-origin-resource-policy", "cross-origin");
  return new Response(res.body, { status: res.status, headers });
}

function editorFile(rel: string): Response {
  const root = resolve(process.cwd(), "editor");
  const clean = normalize(decodeURIComponent(rel || "index.html")).replace(/^([/\\])+/, "");
  let file = resolve(root, clean);
  const relToRoot = relative(root, file);
  if (relToRoot.startsWith("..") || isAbsolute(relToRoot)) return new Response("not found", { status: 404 });
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(clean)) return new Response("not found", { status: 404 });
    file = join(root, "index.html");
    if (!existsSync(file)) return new Response("редактор ещё не собран", { status: 404 });
  }
  const ext = extname(file).toLowerCase();
  const headers: Record<string, string> = {
    "content-type": TYPES[ext] ?? "application/octet-stream",
    "cache-control": ext === ".html" || file.endsWith("harness-desktop.js") ? "no-store" : "public, max-age=300",
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
  };
  return new Response(readFileSync(file), { headers });
}

export default definePlugin({
  name: "diffusion",
  setup(ctx) {
    const roots = () => ({ workspace: ctx.paths.workspace, data: ctx.paths.data });
    const json = (body: unknown, code = 200) => cors(new Response(JSON.stringify(body), {
      status: code,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    }));

    ctx.http({ method: "GET", path: "/films", public: true, surface: "status", handler: () => filmsPage() });
    ctx.http({
      method: "GET",
      path: "/library",
      surface: "status",
      handler: (req) => {
        try {
          return json({ films: listFilms(ctx.paths.data, new URL(req.url).searchParams.get("project") ?? "") });
        } catch (error) {
          return json({ error: { message: error instanceof Error ? error.message : "неизвестный проект" } }, 400);
        }
      },
    });
    ctx.http({
      method: "POST",
      path: "/library",
      surface: "status",
      handler: async (req) => {
        try {
          const body = await req.json() as { name?: string };
          return json({ film: createFilm(ctx.paths.data, new URL(req.url).searchParams.get("project") ?? "", body.name ?? "") });
        } catch (error) {
          return json({ error: { message: error instanceof Error ? error.message : "не получилось создать фильм" } }, 400);
        }
      },
    });
    ctx.http({ method: "GET", path: "/app", public: true, surface: "status", handler: () => editorFile("index.html") });
    ctx.http({
      method: "GET",
      path: "/app/*",
      public: true,
      surface: "status",
      handler: (_req, info) => editorFile(info.params["*"] ?? "index.html"),
    });
    ctx.http({
      method: "GET",
      path: "/ipc/inbox",
      public: true,
      surface: "status",
      handler: () => json(takeInbox()),
    });
    ctx.http({
      method: "*",
      path: "/ipc/out",
      public: true,
      surface: "status",
      handler: async (req) => {
        if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
        if (req.method !== "POST") return json({ error: { message: "нужен POST" } }, 405);
        const body = await req.json() as { channel?: string; payload?: unknown };
        if (!body.channel) return json({ error: { message: "нет канала" } }, 400);
        const reply = await acceptFromEditor(body.channel, body.payload, roots());
        return json(reply ?? { ok: true });
      },
    });
    ctx.http({
      method: "*",
      path: "/media",
      public: true,
      surface: "status",
      handler: async (req) => {
        if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
        const url = new URL(req.url);
        const dir = url.searchParams.get("dir") ?? "";
        const source = url.searchParams.get("path") ?? "";
        try {
          if (req.method === "GET") {
            const file = readMedia(roots(), dir, source);
            return cors(new Response(file.bytes, { headers: { "content-type": file.type, "cache-control": "no-store" } }));
          }
          if (req.method === "PUT") {
            writeMedia(roots(), dir, source, new Uint8Array(await req.arrayBuffer()));
            return json({ ok: true });
          }
          return json({ error: { message: "нужен GET или PUT" } }, 405);
        } catch (error) {
          return json({ error: { message: error instanceof Error ? error.message : "файл не прочитался" } }, 400);
        }
      },
    });
    ctx.http({
      method: "*",
      path: "/api/call",
      public: true,
      surface: "status",
      handler: async (req) => {
        if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
        if (req.method !== "POST") return json({ error: { message: "нужен POST" } }, 405);
        const body = await req.json() as { path?: string; input?: unknown };
        try {
          return json({ result: await cloudCall(ctx.paths.data, body.path ?? "", body.input) });
        } catch (error) {
          return json({ error: { message: error instanceof Error ? error.message : "не подключено" } }, 400);
        }
      },
    });

    ctx.tool({
      name: "diffusion.run",
      description: "Run one command in the film open beside the chat. context lists scenes (id like index.tsx:2) and assets (library path like clip.mov). check, capture and export use the open scene when id is omitted; capture times are seconds. probe, grab, filmstrip, waveform, transcribe and listen need an asset path from context. Pictures come back as files under the chat project _out/diffusion, never as raw bytes. export writes _out/film.mp4 in the chat project unless a path is given. open with no folder reports the open film. window says the pane is visible. logs is empty here. generate and listen/transcribe need an adapter URL or they answer that nothing is connected. job needs the id generate returned. To change the cut, use diffusion.source, not this command.",
      sideEffects: "external",
      input: z.object({
        command: z.enum(COMMANDS),
        args: z.array(z.string()).default([]),
      }),
      async run(input, ctx) {
        if (input.command === "window") return { content: { visible: true } };
        if (input.command === "logs") return { content: { entries: [] } };
        const args = argsOf(input.command, input.args);
        const ms = LONG.has(input.command) ? 600_000 : 180_000;
        try {
          if (input.command === "open" && !("dir" in args)) return { content: await openFilm() };
          if (input.command === "export" && ctx.workspace) {
            const given = typeof args.path === "string" ? args.path : "";
            args.path = given && isAbsolute(given) ? given : join(ctx.workspace, given || join("_out", "film.mp4"));
          }
          return { content: storePictures(await callTool(input.command, args, ms), ctx.workspace, input.command) };
        } catch (error) {
          throw new ToolError("diffusion_run", error instanceof Error ? error.message : "команда не выполнилась");
        }
      },
    });

    ctx.tool({
      name: "diffusion.source",
      description: "Read or replace the open film's index.tsx, or copy one file from the chat project into the film library. The source is the edit. fs cannot see the film folder. write replaces the whole file and the open editor reloads it. import returns the library path to put in src. Read the diffusion-editor skill before the first edit.",
      sideEffects: "write",
      input: z.object({
        action: z.enum(["read", "write", "import"]),
        text: z.string().optional(),
        path: z.string().optional(),
      }),
      async run(input, toolCtx) {
        try {
        const film = await openFilm();
        const file = join(film.dir, "index.tsx");
        if (input.action === "read") return { content: { path: "index.tsx", text: readFileSync(file, "utf8") } };
        if (input.action === "import") {
          const from = input.path ?? "";
          if (!from || !toolCtx.workspace) throw new ToolError("diffusion_source", "нужен path файла в проекте чата");
          const src = resolve(toolCtx.workspace, from);
          const rel = relative(toolCtx.workspace, src);
          if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new ToolError("diffusion_source", "файл должен лежать в проекте чата");
          if (!existsSync(src) || statSync(src).isDirectory()) throw new ToolError("diffusion_source", "файл не найден");
          const name = basename(src);
          mkdirSync(join(film.dir, "assets"), { recursive: true });
          cpSync(src, join(film.dir, "assets", name));
          noteChange(film.dir, `assets/${name}`);
          return { content: { libraryPath: name, file: `assets/${name}` } };
        }
        const text = input.text ?? "";
        if (!text.includes("export default")) throw new ToolError("diffusion_source", "в файле должна быть export default function");
        if (text.length > 200_000) throw new ToolError("diffusion_source", "файл длиннее 200000 символов");
        writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`, "utf8");
        noteChange(film.dir, "index.tsx");
        return { content: { path: "index.tsx", bytes: Buffer.byteLength(text) } };
        } catch (error) {
          if (error instanceof ToolError) throw error;
          throw new ToolError("diffusion_source", error instanceof Error ? error.message : "фильм не открыт");
        }
      },
    });

    ctx.tool({
      name: "diffusion.generate",
      description: "Generate media through the connected model adapter. Asks first. Without an address in adapters.json the call answers that nothing is connected.",
      sideEffects: "external",
      input: z.object({ args: z.array(z.string()).default([]) }),
      async run(input) {
        try {
          return { content: await callTool("generate", argsOf("generate", input.args), 600_000) };
        } catch (error) {
          throw new ToolError("diffusion_generate", error instanceof Error ? error.message : "не подключено");
        }
      },
    });
  },
});

function filmsPage(): Response {
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Видео</title>
<style>
  body { margin: 0; font: 15px/1.4 system-ui, sans-serif; color: #18181b; background: #fff; }
  main { max-width: 640px; margin: 0 auto; padding: 28px 20px 48px; }
  h1 { font-size: 20px; font-weight: 650; margin: 0 0 16px; }
  form { display: flex; gap: 8px; margin-bottom: 18px; }
  input { flex: 1; height: 36px; border: 1px solid #e4e4e7; border-radius: 8px; padding: 0 10px; font: inherit; }
  button { height: 36px; border: 0; border-radius: 8px; padding: 0 14px; background: #18181b; color: #fff; font: inherit; cursor: pointer; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { border-top: 1px solid #f4f4f5; }
  a { display: flex; justify-content: space-between; gap: 12px; padding: 12px 2px; color: inherit; text-decoration: none; }
  a:hover { background: #fafafa; }
  .when { color: #71717a; font-size: 13px; }
  .empty, .err { color: #71717a; }
</style>
<main>
  <h1>Фильмы</h1>
  <p class="err" id="note" hidden></p>
  <form id="add">
    <input name="name" placeholder="Название фильма" required maxlength="80">
    <button type="button" id="create">Новый фильм</button>
  </form>
  <ul id="list"></ul>
</main>
<script>
const PROTO = "tab/1";
let project = "";
let n = 1;
const wait = new Map();
const note = document.getElementById("note");
const list = document.getElementById("list");
function say(text) { note.hidden = !text; note.textContent = text || ""; }
function ask(op, path, body) {
  const id = n++;
  return new Promise((ok, bad) => {
    wait.set(id, { ok, bad });
    parent.postMessage({ sinty: PROTO, id, op, path, body }, "*");
  });
}
function openFilm(id) {
  const back = encodeURIComponent("/p/diffusion/films");
  location.href = "/p/diffusion/app?back=" + back + "#/projects/" + encodeURIComponent(id);
}
function draw(films) {
  list.replaceChildren();
  if (!films.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "В этом проекте пока нет фильмов.";
    list.append(p);
    return;
  }
  for (const film of films) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = "#";
    const name = document.createElement("span");
    name.textContent = film.name;
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = new Date(film.modifiedAt).toLocaleString();
    a.append(name, when);
    a.addEventListener("click", (e) => { e.preventDefault(); openFilm(film.id); });
    li.append(a);
    list.append(li);
  }
}
async function load() {
  if (!project) { say("Откройте вкладку внутри проекта."); return; }
  say("");
  const data = await ask("get", "/library?project=" + encodeURIComponent(project));
  draw(data.films || []);
}
addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.sinty !== PROTO) return;
  if (m.op === "init") { project = m.projectId || ""; load().catch((err) => say(err.message)); }
  const pending = wait.get(m.id);
  if (!pending) return;
  wait.delete(m.id);
  if (m.ok) pending.ok(m.data); else pending.bad(new Error((m.error && m.error.message) || "ошибка"));
});
async function createFilm() {
  const form = document.getElementById("add");
  const input = form.querySelector("input");
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  input.value = "";
  try {
    const data = await ask("post", "/library?project=" + encodeURIComponent(project), { name });
    if (data.film) openFilm(data.film.id);
    else say("Фильм не создался.");
  } catch (err) { say(err.message); }
}
document.getElementById("create").addEventListener("click", () => { createFilm(); });
document.getElementById("add").addEventListener("submit", (e) => { e.preventDefault(); createFilm(); });
const hello = setInterval(() => {
  if (project) { clearInterval(hello); return; }
  parent.postMessage({ sinty: PROTO, op: "ready" }, "*");
}, 300);
parent.postMessage({ sinty: PROTO, op: "ready" }, "*");
</script>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    },
  });
}

const MEDIA = new Set(["probe", "grab", "transcribe", "filmstrip", "waveform", "listen"]);

function positionals(args: string[]): { record: Record<string, unknown>; rest: string[] } {
  const record: Record<string, unknown> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--prompt" || arg === "-p") record.prompt = args[++i] ?? "";
    else if (arg === "--start" || arg === "-s") record.start = Number(args[++i]);
    else if (arg === "--end" || arg === "-e") record.end = Number(args[++i]);
    else if (!arg.startsWith("-")) rest.push(arg);
  }
  return { record, rest };
}

function argsOf(command: string, args: string[]): Record<string, unknown> {
  if (command === "open") {
    const dir = args.find((arg) => !arg.startsWith("-"));
    return dir ? { dir } : {};
  }
  if (command === "job") {
    const id = args.find((arg) => !arg.startsWith("-") && arg !== "list");
    if (!id) throw new ToolError("diffusion_arg", "нужен id задания, который вернул generate");
    return { id, cancel: args.includes("--cancel") };
  }
  const { record, rest } = positionals(args);
  if (command === "check" || command === "capture") {
    const id = rest.find((arg) => !/^\d+(\.\d+)?$/.test(arg));
    const times = rest.filter((arg) => arg !== id).map(Number).filter((n) => Number.isFinite(n));
    return { ...(id ? { id } : {}), ...(times.length ? { times } : {}), ...record };
  }
  if (command === "export") {
    const file = rest.find((arg) => /\.(mp4|webm|mov|ogg)$/i.test(arg));
    const id = rest.find((arg) => arg !== file);
    return { ...(id ? { id } : {}), ...(file ? { path: file } : {}) };
  }
  if (MEDIA.has(command)) {
    const path = rest[0];
    if (!path) throw new ToolError("diffusion_arg", "нужен файл внутри фильма, например assets/@11.mov. Список даёт context.");
    return { ...record, path, ...(rest[1] ? { output: rest[1] } : {}) };
  }
  if (rest[0]) record.path = rest[0];
  if (rest.length > 1) record.output = rest[1];
  return record;
}

async function openFilm(): Promise<{ id: string; name: string; dir: string }> {
  const current = await callTool("context", {}, 30_000) as { projectDir?: string | null };
  const dir = current.projectDir;
  if (!dir) throw new ToolError("diffusion_arg", "Откройте фильм кнопкой «Видео» в шапке чата.");
  let id = "";
  let name = "";
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { projectId?: string; displayName?: string };
    id = pkg.projectId ?? "";
    name = pkg.displayName ?? "";
  } catch {
    /* the folder is enough */
  }
  return { id, name, dir };
}

function pngBytes(value: unknown): Buffer | null {
  if (typeof value === "string" && value.length > 32) {
    const buf = Buffer.from(value, "base64");
    return buf[0] === 0x89 && buf[1] === 0x50 ? buf : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length < 8 || !keys.every((key) => /^\d+$/.test(key))) return null;
  const buf = Buffer.alloc(keys.length);
  for (const key of keys) {
    const n = rec[key];
    if (typeof n !== "number") return null;
    buf[Number(key)] = n & 0xff;
  }
  return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 ? buf : null;
}

/** Picture tools return PNG bytes. Write them into the chat project and hand back the path. */
function storePictures(data: unknown, workspace: string | undefined, command: string): unknown {
  if (!workspace) return data;
  const dir = join(workspace, "_out", "diffusion");
  let n = 0;
  const save = (buf: Buffer): string => {
    mkdirSync(dir, { recursive: true });
    n += 1;
    const file = join(dir, `${command}-${n}.png`);
    writeFileSync(file, buf);
    return file;
  };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "png" || key === "pngBase64" || key === "image") {
        const buf = pngBytes(value);
        if (buf) {
          next.file = save(buf);
          next.bytes = buf.length;
          continue;
        }
      }
      next[key] = walk(value);
    }
    return next;
  };
  return walk(data);
}
