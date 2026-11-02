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

export function takeInbox(since = 0, claim?: { dir?: string; worker?: boolean }): Outgoing[] {
  const now = Date.now();
  const dir = claim?.dir ? normDir(claim.dir) : "";
  if (dir) liveAt.set(dir, now);
  if (dir && !claim?.worker) visibleAt.set(dir, now);
  const events = changes
    .filter((change) => change.id > since && (since > 0 || now - change.at < 1500))
    .map((change) => ({
      id: change.id,
      channel: "main:event",
      payload: { channel: "projects:changed", data: { dir: change.dir, path: change.path } },
    }));
  if (!deliverCalls(dir, claim?.worker === true, now)) return events;
  return [...events, ...outbox.splice(0, outbox.length)];
}

/** The film the agent is cutting. A hidden editor in the harness opens this id. */
export type FilmFocus = { id: string; dir: string; name: string; project: string; at: number };

let focus: FilmFocus | null = null;
const busy = new Map<string, { project: string; name: string; until: number }>();
const watchAt = new Map<string, number>();
const readyAt = new Map<string, number>();
const liveAt = new Map<string, number>();
const visibleAt = new Map<string, number>();

function normDir(dir: string): string {
  return resolve(dir).replace(/[\\/]+$/, "").toLowerCase();
}

/** Calls go to the editor that has this film open. A hidden worker yields when the visible pane is on it. */
function deliverCalls(dir: string, worker: boolean, now: number): boolean {
  if (!focus || now - focus.at > 10 * 60_000) return true;
  if (dir !== normDir(focus.dir)) return false;
  if (worker && now - (visibleAt.get(dir) ?? 0) < 2500) return false;
  return true;
}

export function focusFilm(): FilmFocus | null {
  return focus && Date.now() - focus.at < 10 * 60_000 ? focus : null;
}

/** Marks a film as the one being cut and keeps the sidebar dot on. */
export function engage(info: ProjectInfo): void {
  const project = basename(dirname(info.dir));
  focus = { id: info.id, dir: info.dir, name: info.displayName, project, at: Date.now() };
  hold(info.id, project, info.displayName, 45_000);
}

export function hold(id: string, project: string, name: string, ms: number): void {
  busy.set(id, { project, name, until: Date.now() + ms });
}

/** The dot stays a moment after the command, then goes out. */
export function release(id: string): void {
  const row = busy.get(id);
  if (row) row.until = Date.now() + 8_000;
}

export function isBusy(id: string): boolean {
  const row = busy.get(id);
  return !!row && row.until > Date.now();
}

export function activity(): { films: { id: string; project: string; name: string }[]; projects: string[] } {
  const now = Date.now();
  const films = [...busy.entries()]
    .filter(([, row]) => row.until > now)
    .map(([id, row]) => ({ id, project: row.project, name: row.name }));
  return { films, projects: [...new Set(films.map((film) => film.project))] };
}

/** True once the harness editor has this folder open and the scene has mounted. */
export function editorReady(dir: string): boolean {
  const key = normDir(dir);
  const watched = watchAt.get(key) ?? 0;
  const ready = readyAt.get(key) ?? 0;
  return watched > 0 && ready >= watched - 500 && Date.now() - (liveAt.get(key) ?? 0) < 2500;
}

export async function awaitEditor(dir: string, ms: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (editorReady(dir)) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("Харнес не открыл этот фильм. Обновите вкладку и повторите команду.");
}

function noteEditor(channel: string, data: unknown): void {
  const body = (data ?? {}) as { dir?: unknown };
  const dir = typeof body.dir === "string" ? normDir(body.dir) : "";
  if (!dir) return;
  if (channel === "projects:watch") watchAt.set(dir, Date.now());
  if (channel === "editor:ready") readyAt.set(dir, Date.now());
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

function filmInfos(data: string, project: string): ProjectInfo[] {
  const dir = filmsRoot(data, project);
  if (!existsSync(dir)) return [];
  const films = readdirSync(dir).flatMap((name) => {
    const folder = join(dir, name);
    const info = describe(folder, false);
    if (info) mirrorAssets(data, folder);
    return info ? [info] : [];
  });
  films.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return films;
}

export function listFilms(data: string, project: string): { id: string; name: string; modifiedAt: string; busy: boolean }[] {
  return filmInfos(data, project).map((info) => ({ id: info.id, name: info.displayName, modifiedAt: info.modifiedAt, busy: isBusy(info.id) }));
}

/** The named film in this chat project, or the one the agent is already cutting. */
export function resolveFilm(data: string, project: string, name?: string): ProjectInfo {
  const all = filmInfos(data, project);
  const key = name?.trim();
  if (key) {
    const hit = all.find((film) => film.id === key || film.displayName === key || film.name === key);
    if (!hit) throw new Error(`нет фильма «${key}» в этом проекте`);
    return hit;
  }
  const current = focus && focus.project === project ? all.find((film) => film.id === focus?.id) : undefined;
  if (current) return current;
  if (all.length === 1) return all[0]!;
  throw new Error(all.length === 0 ? "В этом проекте ещё нет фильма. Создайте его через diffusion.film." : "Укажите film: имя фильма. В проекте их несколько.");
}

/** The chat's project id: from the tool context, or from the folder remembered earlier. */
export function projectOfWorkspace(data: string, workspace?: string, hinted?: string): string {
  if (hinted && /^[A-Za-z0-9_-]{1,80}$/.test(hinted)) {
    if (workspace) rememberProject(data, hinted, workspace);
    return hinted;
  }
  if (workspace) {
    try {
      const map = JSON.parse(readFileSync(join(data, "projects.json"), "utf8")) as Record<string, string>;
      const hit = Object.entries(map).find(([, folder]) => normDir(folder) === normDir(workspace));
      if (hit) return hit[0];
    } catch { /* not remembered yet */ }
  }
  throw new Error("Не вижу проект этого чата.");
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
  if (channel === "projects:watch" || channel === "editor:ready") noteEditor(channel, data);
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
    const dir = inside(roots, String(body.dir ?? ""));
    // Claim the write before it lands. A stat in the same millisecond would
    // otherwise look newer: file time keeps the fraction, Date.now() does not.
    canvasWrite = Date.now() + 50;
    const result = saveEdits(dir, body.edits);
    const entry = ["index.tsx", "index.ts", "index.jsx", "index.js"].find((name) => existsSync(join(dir, name)));
    if (entry) canvasWrite = Math.max(canvasWrite, statSync(join(dir, entry)).mtimeMs);
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
  if (channel === "export:target") {
    const filmDir = inside(roots, String(body.dir ?? ""));
    const info = describe(filmDir, false);
    const root = projectFolder(roots.data, basename(dirname(filmDir)));
    if (!info || !root) throw new Error("у этого фильма нет папки проекта чата");
    const ext = body.ext === "png" ? "png" : "mp4";
    const scene = safeSegment(String(body.scene ?? "scene")) || "scene";
    return { path: join(root, "_out", "video", safeSegment(info.displayName), `${scene}.${ext}`) };
  }
  if (channel === "export:assemble") {
    const framesDir = inside(roots, String(body.framesDir ?? ""));
    const outFile = inside(roots, String(body.path ?? ""));
    const fps = Number(body.fps);
    if (!Number.isFinite(fps) || fps <= 0) throw new Error("не задана частота кадров");
    const wav = typeof body.wav === "string" && body.wav ? inside(roots, body.wav) : undefined;
    const bytes = await assembleFilm(framesDir, fps, outFile, wav);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(framesDir, { recursive: true, force: true });
        if (wav) rmSync(wav, { force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    return { file: outFile, bytes };
  }
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
  const names = ["ffmpeg.exe"];
  const dirs = local
    ? [join(local, "Sinty", "tools", "ffmpeg"), join(local, "Sinty", "tools")]
    : [];
  for (const dir of dirs) {
    const direct = join(dir, "ffmpeg.exe");
    if (existsSync(direct)) return direct;
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const nested = join(dir, name, "bin", "ffmpeg.exe");
      if (names.includes("ffmpeg.exe") && existsSync(nested)) return nested;
    }
  }
  return "ffmpeg";
}

/** Encodes a JPEG sequence, and the timeline mix when a wav is present, into one mp4. */
export function assembleFilm(framesDir: string, fps: number, outFile: string, wav?: string): Promise<number> {
  mkdirSync(dirname(outFile), { recursive: true });
  const pattern = join(framesDir, "f-%06d.jpg");
  const args = ["-y", "-framerate", String(fps), "-start_number", "1", "-i", pattern];
  if (wav && existsSync(wav)) args.push("-i", wav);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (wav && existsSync(wav)) args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
  args.push("-movflags", "+faststart", outFile);
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { windowsHide: true });
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
