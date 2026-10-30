import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const REQUEST = "main:request";
const RESPONSE = "main:response";
const CALL = "dapi:call";
const REPLY = "dapi:reply";

export type Roots = { workspace: string; data: string };

type Outgoing = { channel: string; payload: unknown };
type Reply = { id: string; ok: boolean; data?: unknown; error?: { message?: string } };

const outbox: Outgoing[] = [];
const waiting = new Map<string, (reply: Reply) => void>();

const STARTER = `export default function Project() {
  return (
    <stage background="#161616">
    </stage>
  )
}
`;

export function takeInbox(): Outgoing[] {
  return outbox.splice(0, outbox.length);
}

export function callTool(tool: string, args: unknown, ms: number): Promise<unknown> {
  const id = randomUUID();
  outbox.push({ channel: CALL, payload: { id, tool, args } });
  return new Promise((done, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error("Откройте фильм во вкладке «Видео» проекта: редактор не отвечает."));
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
    const info = describe(join(dir, name), false);
    return info ? [{ id: info.id, name: info.displayName, modifiedAt: info.modifiedAt }] : [];
  });
  films.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return films;
}

export function createFilm(data: string, project: string, name: string): { id: string; name: string; modifiedAt: string } {
  const title = name.trim().slice(0, 80) || "Без названия";
  const info = ensureProject(join(filmsRoot(data, project), randomUUID()), title);
  return { id: info.id, name: info.displayName, modifiedAt: info.modifiedAt };
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

/** The compiler packages live next to the plugin. A path outside the grant is not readable, so it is skipped. */
function compilerPackage(): string | null {
  const local = join(process.cwd(), "compiler", "package.json");
  if (readable(local)) return local;
  const noted = join(process.cwd(), "compiler.json");
  if (!readable(noted)) return null;
  const raw = JSON.parse(readFileSync(noted, "utf8")) as { packageJson?: string };
  const pkg = typeof raw.packageJson === "string" ? raw.packageJson : "";
  const abs = pkg ? (isAbsolute(pkg) ? pkg : join(process.cwd(), pkg)) : "";
  return abs && readable(abs) ? abs : null;
}

async function compile(dir: string): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const entry = ["index.tsx", "index.ts", "index.jsx", "index.js"].find((name) => readable(join(dir, name)));
  if (!entry) return { ok: false, error: "нет index.tsx" };
  const pkg = compilerPackage();
  if (!pkg) return { ok: false, error: "компилятор не найден" };
  const script = `
    const { createRequire } = require("node:module");
    const { readFileSync } = require("node:fs");
    const req = createRequire(process.env.COMPILER_PKG);
    const esbuild = req("esbuild");
    const babel = req("@babel/core");
    const solid = req("babel-preset-solid");
    const typescript = req("@babel/preset-typescript");
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

function projectPath(dir: string, source: string): string {
  const abs = isAbsolute(source) ? resolve(source) : resolve(dir, source);
  const rel = relative(dir, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("файл снаружи проекта");
  return abs;
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
  if (channel === "projects:write") return { skipped: [], error: "правка исходника из холста ещё не пишется в файл" };
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
    const folder = projectPath(dir, String(body.source ?? "."));
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
    const file = projectPath(inside(roots, String(body.dir ?? "")), String(body.source ?? ""));
    if (!readable(file)) return null;
    const stat = statSync(file);
    return { size: stat.size, mtime: stat.mtimeMs };
  }
  if (channel === "projects:fs-remove") {
    rmSync(projectPath(inside(roots, String(body.dir ?? "")), String(body.path ?? "")), { recursive: true, force: true });
    return null;
  }
  if (channel === "projects:fs-real-path") return projectPath(inside(roots, String(body.dir ?? "")), String(body.source ?? ""));
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
  const file = projectPath(inside(roots, dir), source);
  if (!readable(file) || statSync(file).isDirectory()) throw new Error("файл не найден");
  const ext = basename(file).toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  return { bytes: readFileSync(file), type: MEDIA_TYPES[ext] ?? "application/octet-stream" };
}

/** Writes bytes into the film. `source` is project-relative, for example `assets/clip.mp4`. */
export function writeMedia(roots: Roots, dir: string, source: string, bytes: Uint8Array): void {
  const file = projectPath(inside(roots, dir), source);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
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
