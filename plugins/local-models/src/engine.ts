import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { assertSafeBinary, llamaSpawnSpec } from "./process.js";
import { isAbsolutePath } from "./validate.js";

function pathDelimiter(): string {
  return delimiter;
}

export interface ProbeResult {
  binaryPath: string;
  version?: string | undefined;
  output: string;
}

export function normalizeServerPath(raw: string): string {
  const path = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!isAbsolutePath(path)) throw new Error("укажите абсолютный путь на машине, где запущен Sinty, не путь из браузера");
  if (path.includes("\0") || path.split(/[\\/]/).includes("..")) throw new Error("недопустимый путь");
  return path;
}

export function resolveExistingBinary(raw: string): string {
  const path = normalizeServerPath(raw);
  if (!existsSync(path)) throw new Error("файл не найден на машине Sinty");
  const st = lstatSync(path);
  if (!st.isFile() && !st.isSymbolicLink()) throw new Error("это не файл");
  const real = st.isSymbolicLink() ? realpathSync(path) : path;
  assertSafeBinary(path);
  if (st.isSymbolicLink()) assertSafeBinary(real);
  return path;
}

export function probeBinary(binaryPath: string, timeoutMs = 8000): Promise<ProbeResult> {
  const path = resolveExistingBinary(binaryPath);
  return new Promise((resolve, reject) => {
    const spec = llamaSpawnSpec(path, ["--version"]);
    const child = spawn(spec.command, spec.args, {
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const take = (d: Buffer): void => {
      chunks.push(d);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      reject(new Error("llama-server --version не ответил вовремя"));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf8").trim();
      if (code && code !== 0 && !/version|llama/i.test(output)) {
        reject(new Error(output || `llama-server --version завершился с кодом ${code}`));
        return;
      }
      const line = output.split(/\r?\n/).find((l) => l.trim()) ?? output;
      resolve({ binaryPath: path, version: line.slice(0, 200) || undefined, output: output.slice(0, 2000) });
    });
  });
}

export function suggestBinaryLocations(): string[] {
  const found: string[] = [];
  const names = process.platform === "win32" ? ["llama-server.exe"] : ["llama-server"];
  const dirs: string[] = [];
  const pathEnv = process.env.PATH ?? "";
  dirs.push(...pathEnv.split(pathDelimiter()).filter(Boolean));
  const local = process.env.LOCALAPPDATA;
  if (local) dirs.push(join(local, "Sinty", "tools"), join(local, "Sinty", "bin"));
  dirs.push(join(homedir(), ".local", "bin"), "/usr/local/bin", "/usr/bin");
  for (const dir of dirs) {
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) {
        try {
          assertSafeBinary(p);
          found.push(p);
        } catch {
          /* skip */
        }
      }
    }
  }
  return [...new Set(found)];
}

