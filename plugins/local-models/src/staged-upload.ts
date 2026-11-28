import { existsSync, lstatSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const DIR = ".uploads";

function assertId(id: string): string {
  if (!/^[a-f0-9]{16,32}$/.test(id)) throw new Error("некорректный идентификатор загрузки");
  return id;
}

function assertInside(root: string, target: string): void {
  const base = resolve(root) + sep;
  const full = resolve(target);
  if (full !== resolve(root) && !full.startsWith(base)) throw new Error("путь загрузки вне каталога плагина");
}

export function readStagedUpload(dataDir: string, id: string): { path: string; bytes: number } {
  const path = resolve(join(dataDir, DIR, assertId(id)));
  assertInside(dataDir, path);
  if (!existsSync(path)) throw new Error("загрузка не найдена");
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error("загрузка не найдена");
  return { path, bytes: st.size };
}

export function removeStagedUpload(dataDir: string, id: string): void {
  const path = resolve(join(dataDir, DIR, assertId(id)));
  assertInside(dataDir, path);
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) throw new Error("загрузка не найдена");
  rmSync(path, { force: true });
}
