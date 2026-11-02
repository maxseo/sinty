import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const require = createRequire(import.meta.url);
const REQUEST = "main:request";
const RESPONSE = "main:response";
const CALL = "dapi:call";
const REPLY = "dapi:reply";

export type Roots = { workspace: string; data: string };

type Outgoing = { channel: string; payload: unknown; id?: number };
type Reply = { id: string; ok: boolean; data?: unknown; error?: { message?: string } };

const outbox: Outgoing[] = [];
const waiting = new Map<string, (reply: Reply) => void>();
const openFiles = new Map<string, { path: string; fd: number }>();
const changes: { id: number; at: number; dir: string; path: string }[] = [];
let changeSeq = 0;
/** When the canvas itself last wrote the film. A newer file is the agent's. */
let canvasWrite = 0;

/** Tells every open editor that a film file changed, so each one recompiles.
 * The editor listens on `main:event`. The note stays until each editor has
 * pulled past it, so a second pane is not left on the old cut. */
export function noteChange(dir: string, path: string): void {
  const rel = path.replace(/\\/g, "/").replace(/^\.?\//, "");
  changeSeq += 1;
  changes.push({ id: changeSeq, at: Date.now(), dir, path: rel });
  if (changes.length > 30) changes.shift();
}

const STARTER = `export default function Project() {
  return (
    <stage background="#161616">
    </stage>
  )
}
`;

export function takeInbox(since = 0): Outgoing[] {
  const now = Date.now();
  const calls = outbox.splice(0, outbox.length);
  const events = changes
    .filter((change) => change.id > since && (since > 0 || now - change.at < 1500))
    .map((change) => ({
      id: change.id,
      channel: "main:event",
      payload: { channel: "projects:changed", data: { dir: change.dir, path: change.path } },
    }));
  return [...events, ...calls];
}

export function callTool(tool: string, args: unknown, ms: number): Promise<unknown> {
  const id = randomUUID();
  outbox.push({ channel: CALL, payload: { id, tool, args } });
  return new Promise((done, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error("Откройте фильм кнопкой «Видео» в шапке чата: редактор не отвечает."));
    }, ms);
    waiting.set(id, (reply) => {
      clearTimeout(timer);
      if (!reply.ok) reject(new Error(reply.error?.message || "команда не выполнилась"));
      else done(reply.data);
    });
  });
}

/** Answers one message from the editor. A request's reply is returned to that caller; it is not put on the shared inbox, which another open film would take. */
export async function acceptFromEditor(channel: string, payload: unknown, roots: Roots): Promise<Outgoing | null> {
  if (channel === REPLY) {
    const reply = payload as Reply;
    const wait = waiting.get(reply.id);
    if (wait) {
      waiting.delete(reply.id);
      wait(reply);
    }
    return null;
  }
  if (channel !== REQUEST) return null;
  const req = payload as { id: string; channel: string; data: unknown };
  try {
    const data = await handleMain(req.channel, req.data, roots);
    return { channel: RESPONSE, payload: { id: req.id, ok: true, data } };
  } catch (error) {
    return { channel: RESPONSE, payload: { id: req.id, ok: false, error: error instanceof Error ? error.message : "ошибка" } };
  }
}

function inside(roots: Roots, dir: string): string {
  const abs = resolve(dir);
  for (const root of [roots.workspace, roots.data]) {
    const rel = relative(root, abs);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return abs;
  }
  throw new Error("папка снаружи рабочей папки");
}

type ProjectInfo = {
  id: string;
  name: string;
  displayName: string;
  dir: string;
  entry: string;
  modifiedAt: string;
  createdAt: string;
  draft: boolean;
};

function readPackage(dir: string): Record<string, unknown> | null {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function describe(dir: string, draft: boolean): ProjectInfo | null {
  const entry = ["index.tsx", "index.ts", "index.jsx", "index.js"].find((name) => existsSync(join(dir, name)));
  if (!entry) return null;
  const pkg = readPackage(dir);
  const stat = statSync(join(dir, entry));
  const folder = statSync(dir);
  return {
    id: typeof pkg?.projectId === "string" ? pkg.projectId : "",
    name: basename(dir),
    displayName: typeof pkg?.displayName === "string" ? pkg.displayName : basename(dir),
    dir,
    entry: typeof pkg?.main === "string" ? pkg.main : entry,
    modifiedAt: stat.mtime.toISOString(),
    createdAt: folder.birthtime.toISOString(),
    draft,
  };
}

function projectKey(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("неизвестный проект");
  return id;
}

function filmsRoot(data: string, project: string): string {
  return join(data, "films", projectKey(project));
}

export function listFilms(data: string, project: string): { id: string; name: string; modifiedAt: string }[] {
  const dir = filmsRoot(data, project);
  if (!existsSync(dir)) return [];
  const films = readdirSync(dir).flatMap((name) => {
    const folder = join(dir, name);
    const info = describe(folder, false);
    if (info) mirrorAssets(data, folder);
    return info ? [{ id: info.id, name: info.displayName, modifiedAt: info.modifiedAt }] : [];
  });
  films.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return films;
}

export function createFilm(data: string, project: string, name: string): { id: string; name: string; modifiedAt: string; assets: string | null } {
  const title = name.trim().slice(0, 80) || "Без названия";
  const info = ensureProject(join(filmsRoot(data, project), randomUUID()), title);
  return { id: info.id, name: info.displayName, modifiedAt: info.modifiedAt, assets: mirrorAssets(data, info.dir) };
}

export function findFilm(data: string, id: string): ProjectInfo | null {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) return null;
  const root = join(data, "films");
  if (!existsSync(root)) return null;
  for (const project of readdirSync(root)) {
    const dir = join(root, project);
    if (!statSync(dir).isDirectory()) continue;
    for (const folder of readdirSync(dir)) {
      const info = describe(join(dir, folder), false);
      if (info && (info.id === id || folder === id)) return info;
    }
  }
  return null;
}

function ensureProject(dir: string, displayName: string): ProjectInfo {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "index.tsx")) && !existsSync(join(dir, "index.ts")) && !existsSync(join(dir, "index.jsx")) && !existsSync(join(dir, "index.js"))) {
    writeFileSync(join(dir, "index.tsx"), STARTER, "utf8");
  }
  if (!existsSync(join(dir, "package.json"))) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-") || "project",
      projectId: randomUUID(),
      displayName,
      private: true,
      type: "module",
      main: "index.tsx",
    }, null, 2), "utf8");
  }
  if (!existsSync(join(dir, "assets.yml"))) writeFileSync(join(dir, "assets.yml"), "version: 1\nfolders: []\nassets: []\n", "utf8");
  const project = describe(dir, dir.includes(`${join("diffusion", "drafts")}`));
  if (!project) throw new Error("не получилось создать проект");
  return project;
}

function readable(file: string): boolean {
  try { return existsSync(file); } catch { return false; }
}

/** A compiler package is usable only when its own esbuild can be loaded. A forked plugin folder can contain package.json without node_modules. */
function usableCompiler(pkg: string): string | null {
  if (!readable(pkg)) return null;
  try {
    createRequire(pkg).resolve("esbuild");
    return pkg;
  } catch {
    return null;
  }
}

/** The compiler packages live next to the plugin. A path outside the grant is not readable, so it is skipped. */
function compilerPackage(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "compiler", "package.json"),
    join(here, "compiler", "package.json"),
    join(here, "..", "compiler", "package.json"),
  ];
  const noted = join(process.cwd(), "compiler.json");
  if (readable(noted)) {
    try {
      const raw = JSON.parse(readFileSync(noted, "utf8")) as { packageJson?: string };
      if (typeof raw.packageJson === "string" && raw.packageJson) {
        candidates.push(isAbsolute(raw.packageJson) ? raw.packageJson : join(process.cwd(), raw.packageJson));
      }
    } catch {
      /* a bad note is skipped */
    }
  }
  for (const pkg of candidates) {
    const usable = usableCompiler(pkg);
    if (usable) return usable;
  }
  return null;
}

function loadWriter(): (dir: string, edits: unknown) => { skipped: string[]; ids: Record<string, string>; unrolled: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["compiler/write.cjs", "../compiler/write.cjs"]) {
    const file = join(here, rel);
    if (readable(file)) return require(file) as (dir: string, edits: unknown) => { skipped: string[]; ids: Record<string, string>; unrolled: string[] };
  }
  throw new Error("нет write.cjs");
}

/** Lets a canvas edit stay on the stage. The JSX file is not rewritten yet, so a reload shows the file again. Answering with an error makes the editor delete the clip it just added. */
function keepEdits(edits: unknown): { skipped: string[]; ids: Record<string, string>; unrolled: string[] } {
  const ids: Record<string, string> = {};
  const unrolled: string[] = [];
  const list = Array.isArray(edits) ? edits : [];
  for (const edit of list) {
    if (!edit || typeof edit !== "object") continue;
    const row = edit as { kind?: unknown; source?: unknown; iterations?: unknown };
    if (typeof row.source === "string" && row.source.startsWith("pending#")) ids[row.source] = row.source;
    if (row.kind === "unroll" && typeof row.source === "string") unrolled.push(row.source);
    if (!Array.isArray(row.iterations)) continue;
    for (const iteration of row.iterations) {
      if (!iteration || typeof iteration !== "object") continue;
      for (const value of Object.values(iteration as Record<string, { pending?: unknown }>)) {
        if (value && typeof value.pending === "string") ids[value.pending] = value.pending;
      }
    }
  }
  return { skipped: [], ids, unrolled };
}

/** Persists the cut in the film file. A writer failure keeps the open session as it was, so a clip is not thrown away. */
function saveEdits(dir: string, edits: unknown): { skipped: string[]; ids: Record<string, string>; unrolled: string[] } {
  try {
    return loadWriter()(dir, edits);
  } catch {
    return keepEdits(edits);
  }
}

async function compile(dir: string): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const entry = ["index.tsx", "index.ts", "index.jsx", "index.js"].find((name) => readable(join(dir, name)));
  if (!entry) return { ok: false, error: "нет index.tsx" };
  const pkg = compilerPackage();
  if (!pkg) return { ok: false, error: "компилятор не найден" };
  const script = `
    const { createRequire } = require("node:module");
    const { readFileSync } = require("node:fs");
    const { dirname } = require("node:path");
    const req = createRequire(process.env.COMPILER_PKG);
    const esbuild = req("esbuild");
    const babel = req("@babel/core");
    const solid = req("babel-preset-solid");
    const typescript = req("@babel/preset-typescript");
    const tags = req("./tags.cjs");
    esbuild.build({
      bundle: true, write: false, format: "cjs", platform: "browser", target: "chrome130",
      external: ["solid-js", "solid-js/*", "@diffusionstudio/jsx"],
      entryPoints: [process.env.COMPILER_ENTRY], logLevel: "silent",
      plugins: [{ name: "solid", setup(build) {
        build.onLoad({ filter: /\\.[jt]sx?$/ }, async (args) => {
          if (args.path.includes("node_modules")) return undefined;
          const source = readFileSync(args.path, "utf8");
          const out = await babel.transformAsync(source, {
            filename: args.path, babelrc: false, configFile: false,
            plugins: [[tags, { root: dirname(process.env.COMPILER_ENTRY) }]],
            presets: [
              [solid.default || solid, { generate: "universal", moduleName: "@diffusionstudio/jsx" }],
              [typescript.default || typescript, { onlyRemoveTypeImports: true }],
            ],
          });
          return { contents: out && out.code || "", loader: "js" };
        });
      }}],
    }).then((result) => {
      process.stdout.write(JSON.stringify({ ok: true, code: result.outputFiles[0].text }));
    }).catch((error) => {
      process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "не скомпилировалось" }));
    });
  `;
  return new Promise((done) => {
    const child = spawn(process.execPath, ["-e", script], {
      windowsHide: true,
      env: { ...process.env, COMPILER_PKG: pkg, COMPILER_ENTRY: join(dir, entry) },
    });
    let out = "";
    child.stdout.on("data", (buf: Buffer) => { out += buf.toString("utf8"); });
    child.on("error", (error) => done({ ok: false, error: error.message }));
    child.on("close", () => {
      try { done(JSON.parse(out) as { ok: true; code: string } | { ok: false; error: string }); }
      catch { done({ ok: false, error: out || "не скомпилировалось" }); }
    });
  });
}

function under(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function projectPath(dir: string, source: string, roots: Roots): string {
  const abs = isAbsolute(source) ? resolve(source) : resolve(dir, source);
  const rel = relative(dir, abs);
  if (!(rel.startsWith("..") || isAbsolute(rel))) return abs;
  if (under(roots.workspace, abs) || under(roots.data, abs)) return abs;
  throw new Error("файл должен лежать в папке фильма или в проекте чата");
}

function bytesOf(data: unknown): Buffer {
  if (typeof data === "string") return Buffer.from(data, "base64");
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data) && data.every((item) => typeof item === "number")) return Buffer.from(data);
  if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length && keys.every((key) => /^\d+$/.test(key))) {
      const buf = Buffer.alloc(keys.length);
      for (const key of keys) buf[Number(key)] = Number(rec[key]) & 0xff;
      return buf;
    }
  }
  return Buffer.alloc(0);
}

async function handleMain(channel: string, data: unknown, roots: Roots): Promise<unknown> {
  const body = (data ?? {}) as Record<string, unknown>;
  if (channel === "auth:get-pending-callback" || channel === "checkout:get-pending-callback") return null;
  if (channel === "window:is-fullscreen") return false;
  if (channel === "window:set-color-mode" || channel === "window:set-busy" || channel === "window:show" || channel === "analytics:configure") return null;
  if (channel === "window:capture") return { width: 0, height: 0 };
  if (channel === "logs:get" || channel === "clipboard:paths" || channel === "app:editors-list") return [];
  if (channel === "agent-chat:endpoint") return null;
  if (channel === "mcp:status") return { url: "", agents: [] };
  if (channel === "mcp:apply") return { added: [], removed: [], failures: [] };
  if (channel === "cli:status") return { installed: false, path: null, managed: false, available: false };
  if (channel === "cli:install" || channel === "cli:uninstall") return { status: "absent" };
  if (channel === "projects:pick-folder") return roots.workspace;
  if (channel === "projects:ask-missing") return "cancel";
  if (channel === "projects:open-id") return findFilm(roots.data, String(body.id ?? ""));
  if (channel === "projects:create") {
    const id = randomUUID();
    return ensureProject(join(roots.data, "drafts", id), "Untitled");
  }
  if (channel === "projects:init" || channel === "projects:resolve" || channel === "projects:get") {
    const dir = inside(roots, String(body.dir ?? ""));
    if (channel === "projects:get" && !existsSync(dir)) return null;
    if (channel === "projects:resolve" && !existsSync(dir)) return null;
    return ensureProject(dir, basename(dir));
  }
  if (channel === "projects:pick-save") {
    const name = String(body.name ?? "project").replace(/[<>:"/\\|?*]/g, "-");
    return join(roots.workspace, name);
  }
  if (channel === "projects:save" || channel === "projects:move") {
    const from = inside(roots, String(body.dir ?? ""));
    const target = inside(roots, String(body.target ?? ""));
    mkdirSync(target, { recursive: true });
    if (resolve(from) !== resolve(target)) cpSync(from, target, { recursive: true });
    return ensureProject(target, basename(target));
  }
  if (channel === "projects:rename") {
    const dir = inside(roots, String(body.dir ?? ""));
    const pkg = readPackage(dir) ?? {};
    pkg.displayName = String(body.displayName ?? basename(dir));
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
    return ensureProject(dir, String(pkg.displayName));
  }
  if (channel === "projects:duplicate") {
    const dir = inside(roots, String(body.dir ?? ""));
    const target = inside(roots, join(dirnameSafe(dir), `${basename(dir)}-copy`));
    cpSync(dir, target, { recursive: true });
    const pkg = readPackage(target) ?? {};
    pkg.projectId = randomUUID();
    writeFileSync(join(target, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
    return ensureProject(target, basename(target));
  }
  if (channel === "projects:delete") {
    rmSync(inside(roots, String(body.dir ?? "")), { recursive: true, force: true });
    return null;
  }
  if (channel === "projects:compile") return compile(inside(roots, String(body.dir ?? "")));
  if (channel === "projects:write") {
    const result = saveEdits(inside(roots, String(body.dir ?? "")), body.edits);
    canvasWrite = Date.now();
    return result;
  }
  if (channel === "projects:watch" || channel === "projects:unwatch") return null;
  if (channel === "projects:manifest-read") {
    const file = join(inside(roots, String(body.dir ?? "")), "assets.yml");
    if (!readable(file)) return null;
    try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  }
  if (channel === "projects:manifest-write") {
    writeFileSync(join(inside(roots, String(body.dir ?? "")), "assets.yml"), typeof body.manifest === "string" ? body.manifest : JSON.stringify(body.manifest ?? {}), "utf8");
    return null;
  }
  if (channel === "projects:config-read") {
    const pkg = readPackage(inside(roots, String(body.dir ?? "")));
    return pkg?.diffusion ?? null;
  }
  if (channel === "projects:config-write") {
    const dir = inside(roots, String(body.dir ?? ""));
    const pkg = readPackage(dir) ?? {};
    if (body.config == null) delete pkg.diffusion;
    else pkg.diffusion = body.config;
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
    return null;
  }
  if (channel === "projects:fs-list") {
    const dir = inside(roots, String(body.dir ?? ""));
    const folder = projectPath(dir, String(body.source ?? "."), roots);
    if (!readable(folder)) return [];
    try {
      return readdirSync(folder, { withFileTypes: true }).map((entry) => {
        const stat = statSync(join(folder, entry.name));
        return { name: entry.name, kind: entry.isDirectory() ? "directory" : "file", size: stat.size, mtime: stat.mtimeMs };
      });
    } catch {
      return [];
    }
  }
  if (channel === "projects:fs-stat") {
    const file = projectPath(inside(roots, String(body.dir ?? "")), String(body.source ?? ""), roots);
    if (!readable(file)) return null;
    const stat = statSync(file);
    return { size: stat.size, mtime: stat.mtimeMs, external: stat.mtimeMs > canvasWrite };
  }
  if (channel === "projects:fs-remove") {
    rmSync(projectPath(inside(roots, String(body.dir ?? "")), String(body.path ?? ""), roots), { recursive: true, force: true });
    return null;
  }
  if (channel === "projects:fs-real-path") return projectPath(inside(roots, String(body.dir ?? "")), String(body.source ?? ""), roots);
  if (channel === "file:write-open") {
    const path = projectPath(roots.workspace, String(body.path ?? ""), roots);
    mkdirSync(dirname(path), { recursive: true });
    const id = randomUUID();
    openFiles.set(id, { path, fd: openSync(path, "w") });
    return { id };
  }
  if (channel === "file:write-chunk") {
    const open = openFiles.get(String(body.id ?? ""));
    if (!open) throw new Error("файл уже закрыт");
    const buf = bytesOf(body.data);
    writeSync(open.fd, buf, 0, buf.length, Number(body.position ?? 0));
    return null;
  }
  if (channel === "file:write-close" || channel === "file:write-abort") {
    const id = String(body.id ?? "");
    const open = openFiles.get(id);
    if (!open) return null;
    closeSync(open.fd);
    openFiles.delete(id);
    if (channel === "file:write-abort") rmSync(open.path, { force: true });
    return null;
  }
  if (channel === "projects:find-moved") return null;
  return null;
}

const MEDIA_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/** A file of the film, for the editor to play. `source` is project-relative. */
export function readMedia(roots: Roots, dir: string, source: string): { bytes: Buffer; type: string } {
  const file = projectPath(inside(roots, dir), source, roots);
  if (!readable(file) || statSync(file).isDirectory()) throw new Error("файл не найден");
  const ext = basename(file).toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  return { bytes: readFileSync(file), type: MEDIA_TYPES[ext] ?? "application/octet-stream" };
}

/** Writes bytes into the film. `source` is project-relative, for example `assets/clip.mp4`. */
export function writeMedia(roots: Roots, dir: string, source: string, bytes: Uint8Array): void {
  const file = projectPath(inside(roots, dir), source, roots);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  if (source.replace(/\\/g, "/").startsWith("assets/")) mirrorAssets(roots.data, inside(roots, dir));
}

/** A path segment that is safe as a folder name on Windows. */
export function safeSegment(name: string): string {
  const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").trim().replace(/[. ]+$/g, "");
  return clean.slice(0, 80) || "film";
}

/** Remembers which chat-project folder a film project belongs to. The roster sits outside this plugin's grant. */
export function rememberProject(data: string, projectId: string, workspace: string): void {
  if (!projectId || !workspace) return;
  const file = join(data, "projects.json");
  let map: Record<string, string> = {};
  try { map = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>; } catch { /* first film */ }
  if (map[projectId] === workspace) return;
  map[projectId] = workspace;
  writeFileSync(file, JSON.stringify(map), "utf8");
}

function projectFolder(data: string, projectId: string): string | null {
  try {
    const map = JSON.parse(readFileSync(join(data, "projects.json"), "utf8")) as Record<string, string>;
    if (map[projectId]) return map[projectId];
  } catch { /* not remembered yet */ }
  try {
    const roster = JSON.parse(readFileSync(join(dirname(data), "roster.json"), "utf8")) as { projects?: { id: string; slug: string }[] };
    const slug = roster.projects?.find((row) => row.id === projectId)?.slug;
    if (slug) return join(dirname(dirname(data)), "workspace", "projects", slug);
  } catch { /* roster is outside the grant */ }
  return null;
}

/** `_inbox/assets/<film name>` inside the chat project. The editor still reads the film folder; this is the copy the agent can open. */
export function assetInbox(data: string, filmDir: string): string | null {
  const info = describe(filmDir, false);
  if (!info) return null;
  const root = projectFolder(data, basename(dirname(filmDir)));
  if (!root) return null;
  return join(root, "_inbox", "assets", safeSegment(info.displayName));
}

/** Copies film library files into the chat project. A newer film file replaces the copy. */
export function mirrorAssets(data: string, filmDir: string): string | null {
  const dest = assetInbox(data, filmDir);
  if (!dest) return null;
  mkdirSync(dest, { recursive: true });
  const src = join(filmDir, "assets");
  if (!existsSync(src)) return dest;
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    if (!existsSync(from) || statSync(from).isDirectory()) continue;
    const to = join(dest, name);
    if (!existsSync(to) || statSync(from).mtimeMs > statSync(to).mtimeMs) cpSync(from, to);
  }
  return dest;
}

function ffmpegBin(): string {
  const local = process.env.LOCALAPPDATA;
  const bundled = local ? join(local, "Sinty", "tools", "ffmpeg", "ffmpeg.exe") : "";
  if (bundled && existsSync(bundled)) return bundled;
  return "ffmpeg";
}

/** Encodes a JPEG sequence into one mp4. The frames are the composited picture. */
export function assembleFilm(framesDir: string, fps: number, outFile: string): Promise<number> {
  mkdirSync(dirname(outFile), { recursive: true });
  const pattern = join(framesDir, "f-%06d.jpg");
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), ["-y", "-framerate", String(fps), "-start_number", "1", "-i", pattern, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outFile], { windowsHide: true });
    let err = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      err += String(chunk);
      if (err.length > 8000) err = err.slice(-8000);
    });
    child.on("error", () => reject(new Error("ffmpeg не запустился")));
    child.on("close", (code) => {
      if (code !== 0 || !existsSync(outFile)) reject(new Error(err.trim().split("\n").slice(-4).join(" ") || `ffmpeg ${code}`));
      else resolve(statSync(outFile).size);
    });
  });
}

function dirnameSafe(dir: string): string {
  const parent = resolve(dir, "..");
  return parent;
}

type Adapters = { generate?: string; transcribe?: string; listen?: string; account?: string };

function adapters(data: string): Adapters {
  const file = join(data, "adapters.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Adapters;
  } catch {
    return {};
  }
}

function modelOf(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as { model?: unknown; request?: { model?: unknown } };
  if (typeof record.model === "string") return record.model;
  if (typeof record.request?.model === "string") return record.request.model;
  return "";
}

/** Cloud calls the editor used to send to api.diffusion.studio. */
export async function cloudCall(data: string, path: string, input: unknown): Promise<unknown> {
  if (path === "events.track") return { ok: true };
  if (path === "models.list") return [];
  const cfg = adapters(data);
  const model = modelOf(input);
  let url = cfg.generate;
  if (model === "universal-3.5-pro") url = cfg.transcribe;
  else if (model === "qwen3.8-omni-flash") url = cfg.listen;
  else if (path.startsWith("account.")) url = cfg.account;
  if (!url) throw new Error("не подключено");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, input }),
  });
  const body = await res.json() as { result?: unknown; error?: string };
  if (!res.ok) throw new Error(body.error || "не подключено");
  return body.result ?? body;
}
