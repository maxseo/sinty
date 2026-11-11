import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync, statSync, lstatSync, renameSync, type WriteStream } from "node:fs";
import { statfs } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** Staging folder inside a plugin's $DATA. Survives app updates; not inside the immutable install. */
export const PLUGIN_UPLOAD_DIR = ".uploads";
const MAX_NAME = 180;
const MAX_BYTES = 200 * 1024 * 1024 * 1024;
const MIN_FREE = 64 * 1024 * 1024;

export function pluginUploadTooBigMessage(): string {
  return "файл больше 200 ГБ";
}

/** A file name for an upload: no path, no traversal, no reserved names. */
export function safeUploadFilename(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("нужно имя файла");
  const trimmed = raw.trim();
  const normalized = trimmed.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((p) => p.length > 0);
  if (parts.some((p) => p === "." || p === "..")) throw new Error("недопустимое имя файла");
  const absolute = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/");
  if (parts.length > 1 && !absolute) throw new Error("недопустимое имя файла");
  const name = parts.pop()?.trim() ?? "";
  if (!name || name.length > MAX_NAME) throw new Error("недопустимое имя файла");
  if (name === "." || name === ".." || name.endsWith(".") || name.endsWith(" ")) throw new Error("недопустимое имя файла");
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) throw new Error("недопустимое имя файла");
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)) throw new Error("имя файла должно быть простым (латиница, цифры, точка, -, _)");
  return name;
}

export function pluginUploadPath(dataDir: string, id: string): string {
  if (!/^[a-f0-9]{16,32}$/.test(id)) throw new Error("некорректный идентификатор загрузки");
  return resolve(join(dataDir, PLUGIN_UPLOAD_DIR, id));
}

function assertInside(root: string, target: string): void {
  const base = resolve(root) + sep;
  const full = resolve(target);
  if (full !== resolve(root) && !full.startsWith(base)) throw new Error("путь загрузки вне каталога плагина");
}

async function writeChunk(out: WriteStream, value: Uint8Array): Promise<void> {
  if (out.destroyed || out.writableEnded) return;
  return new Promise((resolveWrite, reject) => {
    out.write(value, (err) => {
      if (!err || out.destroyed) resolveWrite();
      else reject(err);
    });
  });
}

async function endStream(out: WriteStream): Promise<void> {
  return new Promise((resolveEnd, reject) => {
    out.end((err: Error | null | undefined) => (err ? reject(err) : resolveEnd()));
  });
}

export interface PluginUploadResult {
  id: string;
  filename: string;
  relativePath: string;
  bytes: number;
}

/**
 * Streams an upload into `$DATA/.uploads/<id>` without buffering the file in memory.
 * Atomic (temp then rename), no overwrite, no symlink follow, cancellable, checks free disk.
 */
export async function savePluginUpload(opts: {
  dataDir: string;
  body: ReadableStream;
  filename: string;
  contentLength?: number | undefined;
  signal?: AbortSignal | undefined;
  freeBytes?: () => Promise<number>;
}): Promise<PluginUploadResult> {
  const filename = safeUploadFilename(opts.filename);
  const announced = opts.contentLength;
  if (announced !== undefined && (!Number.isFinite(announced) || announced <= 0)) throw new Error("пустой файл");
  if (announced !== undefined && announced > MAX_BYTES) throw new Error(pluginUploadTooBigMessage());

  const root = resolve(opts.dataDir);
  const dir = join(root, PLUGIN_UPLOAD_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertInside(root, dir);
  const dirStat = lstatSync(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error("каталог загрузок повреждён");

  const freeBytes = opts.freeBytes ?? (async () => {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  });
  const need = announced && announced > 0 ? announced + MIN_FREE : MIN_FREE;
  const free = await freeBytes();
  if (Number.isFinite(free) && free < need) throw new Error("недостаточно места на диске");

  const id = randomBytes(8).toString("hex");
  const dest = join(dir, id);
  const tmp = join(dir, `.${id}.part`);
  assertInside(dir, dest);
  assertInside(dir, tmp);
  if (existsQuiet(dest) || existsQuiet(tmp)) throw new Error("конфликт загрузки, повторите");

  const flags = process.platform === "win32" ? "wx" : "wx";
  const out = createWriteStream(tmp, { flags, mode: 0o600 });
  out.on("error", () => undefined);
  const reader = opts.body.getReader();
  let size = 0;
  const onAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (opts.signal?.aborted) throw new Error("загрузка отменена");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error(pluginUploadTooBigMessage());
      if (announced !== undefined && size > announced) throw new Error("размер файла больше заявленного");
      await writeChunk(out, value);
    }
    if (!size) throw new Error("файл пустой");
    if (announced !== undefined && size !== announced) throw new Error("размер файла не совпал с заявленным");
    await endStream(out);
    const st = lstatSync(tmp);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error("временный файл повреждён");
    renameSync(tmp, dest);
    const final = lstatSync(dest);
    if (final.isSymbolicLink() || !final.isFile()) {
      rmSync(dest, { force: true });
      throw new Error("файл загрузки повреждён");
    }
  } catch (e) {
    await new Promise<void>((done) => {
      const finish = (): void => done();
      if (out.destroyed || out.closed) finish();
      else {
        out.once("close", finish);
        try { out.destroy(); } catch { finish(); }
        setTimeout(finish, 50);
      }
    });
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    if (!(existsQuiet(dest) && !opts.signal?.aborted)) {
      try { rmSync(dest, { force: true }); } catch { /* ignore */ }
    }
    throw e;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
  return { id, filename, relativePath: `${PLUGIN_UPLOAD_DIR}/${id}`, bytes: size };
}

export function readPluginUpload(dataDir: string, id: string): { path: string; bytes: number } {
  const path = pluginUploadPath(dataDir, id);
  assertInside(resolve(dataDir), path);
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error("загрузка не найдена");
  return { path, bytes: st.size };
}

export function removePluginUpload(dataDir: string, id: string): void {
  const path = pluginUploadPath(dataDir, id);
  assertInside(resolve(dataDir), path);
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw new Error("загрузка не найдена");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return;
    throw e;
  }
  rmSync(path, { force: true });
}

function existsQuiet(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

