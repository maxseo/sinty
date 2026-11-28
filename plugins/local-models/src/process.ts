import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { LaunchProfile, ModelAsset } from "./types.js";
import { logsDir, runtimeDir } from "./registry.js";

export const LOG_CAP = 64 * 1024;

export interface OwnedProcess {
  child: ChildProcess;
  pid: number;
  port: number;
  apiKey: string;
  identity: string;
  binaryPath: string;
  startedAt: string;
  logFile: string;
}

export interface LlamaArgs {
  binaryPath: string;
  modelPath: string;
  mmprojPath?: string | undefined;
  profile: Pick<LaunchProfile, "ctxSize" | "gpuLayers" | "cacheTypeK" | "cacheTypeV" | "parallel" | "host">;
  port: number;
  alias: string;
  apiKeyFile: string;
}


/** Test fixture: Windows cannot spawn a raw .js file. Production always execs the selected binary as argv (no shell). */
export function isTestLlamaFixture(binaryPath: string): boolean {
  const base = binaryPath.replace(/\\/g, "/").split("/").pop() ?? "";
  return process.env.SINTY_LOCAL_MODELS_TEST === "1" && /^llama-server(\.mjs|\.js)?$/i.test(base);
}

export function llamaSpawnSpec(binaryPath: string, argv: string[]): { command: string; args: string[] } {
  if (isTestLlamaFixture(binaryPath)) return { command: process.execPath, args: [binaryPath, ...argv] };
  return { command: binaryPath, args: argv };
}

export function buildLlamaArgs(input: LlamaArgs): { argv: string[]; env: NodeJS.ProcessEnv } {
  const argv = [
    "--model",
    input.modelPath,
    "--host",
    input.profile.host,
    "--port",
    String(input.port),
    "--alias",
    input.alias,
    "--ctx-size",
    String(input.profile.ctxSize),
    "--n-gpu-layers",
    String(input.profile.gpuLayers),
    "--cache-type-k",
    input.profile.cacheTypeK,
    "--cache-type-v",
    input.profile.cacheTypeV,
    "--parallel",
    String(input.profile.parallel),
    "--api-key-file",
    input.apiKeyFile,
    "--no-webui",
  ];
  if (input.mmprojPath) argv.push("--mmproj", input.mmprojPath);
  return { argv, env: { ...process.env, SINTY_LOCAL_MODELS_ID: identityFromKeyFile(input.apiKeyFile) } };
}

function identityFromKeyFile(apiKeyFile: string): string {
  return createHash("sha256").update(apiKeyFile).digest("hex").slice(0, 16);
}

export function assertSafeBinary(binaryPath: string): void {
  if (!existsSync(binaryPath)) throw new Error("бинарник llama-server не найден");
  const st = lstatSync(binaryPath);
  if (st.isSymbolicLink()) {
    // allow a symlink only if the final file exists; still execute the given path
  }
  if (!st.isFile() && !st.isSymbolicLink()) throw new Error("путь к llama-server должен быть файлом");
  const base = binaryPath.replace(/\\/g, "/").split("/").pop() ?? "";
  const fixture = process.env.SINTY_LOCAL_MODELS_TEST === "1" && /^llama-server(\.mjs|\.js)?$/i.test(base);
  if (!fixture && !/^llama-server(\.exe)?$/i.test(base)) throw new Error("ожидается исполняемый файл llama-server");
}

export function pickFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      server.close((err) => {
        if (err) reject(err);
        else if (!addr || typeof addr === "string") reject(new Error("не удалось выбрать порт"));
        else resolve(addr.port);
      });
    });
  });
}

export function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export interface HealthResult {
  status: "loading" | "ready" | "error" | "down";
  http?: number | undefined;
  detail?: string | undefined;
}

export async function checkHealth(port: number, apiKey: string, timeoutMs = 2000): Promise<HealthResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: ac.signal,
    });
    if (res.status === 200) return { status: "ready", http: 200 };
    if (res.status === 503) return { status: "loading", http: 503 };
    if (res.status === 401 || res.status === 403) return { status: "error", http: res.status, detail: "на порту чужой процесс (ключ не подошёл)" };
    return { status: "error", http: res.status, detail: `health HTTP ${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (ac.signal.aborted || /ECONNREFUSED|fetch failed|AbortError/i.test(msg)) return { status: "down", detail: msg };
    return { status: "error", detail: msg };
  } finally {
    clearTimeout(timer);
  }
}

export function writeApiKeyFile(dataDir: string, apiKey: string): string {
  const dir = runtimeDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "api-key");
  writeFileSync(file, apiKey + "\n", { mode: 0o600 });
  return file;
}

export function tailLog(file: string, cap = LOG_CAP): string {
  if (!existsSync(file)) return "";
  const buf = readFileSync(file);
  const slice = buf.length > cap ? buf.subarray(buf.length - cap) : buf;
  return slice.toString("utf8").replace(/sk-[A-Za-z0-9_-]{8,}|[a-f0-9]{32,}/gi, "[скрыто]");
}

/**
 * Starts llama-server as our child. Hidden on Windows (no new console).
 * stdio is piped so we can journal it; we never use detached+ignore, which spawned console storms.
 */
export function spawnOwned(dataDir: string, args: LlamaArgs): OwnedProcess {
  assertSafeBinary(args.binaryPath);
  const { argv, env } = buildLlamaArgs(args);
  const identity = randomBytes(16).toString("hex");
  env.SINTY_LOCAL_MODELS_ID = identity;
  mkdirSync(logsDir(dataDir), { recursive: true, mode: 0o700 });
  const logFile = join(logsDir(dataDir), `server-${args.port}.log`);
  const log = createWriteStream(logFile, { flags: "a", mode: 0o600 });
  const { command, args: commandArgs } = llamaSpawnSpec(args.binaryPath, argv);
  const child = spawn(command, commandArgs, {
    shell: false,
    windowsHide: true,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    env,
    cwd: dirname(args.binaryPath),
  });
  if (!child.pid) {
    log.end();
    throw new Error("не удалось запустить llama-server");
  }
  const onData = (chunk: Buffer): void => {
    log.write(chunk);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("exit", () => {
    log.end();
  });
  return {
    child,
    pid: child.pid,
    port: args.port,
    apiKey: readFileSync(args.apiKeyFile, "utf8").trim(),
    identity,
    binaryPath: args.binaryPath,
    startedAt: new Date().toISOString(),
    logFile,
  };
}

export function stopOwned(owned: OwnedProcess, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve) => {
    const child = owned.child;
    if (child.exitCode !== null || child.killed) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      child.removeListener("exit", done);
      resolve();
    };
    child.once("exit", done);
    try {
      child.kill("SIGTERM");
    } catch {
      done();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
  });
}

/** Never kill a PID we have not confirmed with our API key on our port. */
export async function confirmOwnServer(port: number, apiKey: string): Promise<boolean> {
  const health = await checkHealth(port, apiKey, 1500);
  return health.status === "ready" || health.status === "loading";
}

export function primaryWeights(asset: ModelAsset): string {
  const main = asset.files.find((f) => f.role === "weights") ?? asset.files.find((f) => f.role === "shard");
  if (!main) throw new Error("у модели нет основного GGUF");
  return main.path;
}

export function mmprojPath(asset: ModelAsset): string | undefined {
  return asset.files.find((f) => f.role === "mmproj")?.path;
}

export function redactText(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("[скрыто]");
  }
  return out.replace(/Bearer\s+\S+/gi, "Bearer [скрыто]");
}

export async function pidListeningOnPort(port: number, host = "127.0.0.1"): Promise<number | undefined> {
  if (process.platform === "linux") {
    const fs = await import("node:fs");
    const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
    const scan = (file: string, anyAddr = false): number | undefined => {
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        return undefined;
      }
      for (const line of text.split("\n").slice(1)) {
        const cols = line.trim().split(/\s+/);
        const local = cols[1] ?? "";
        const inode = cols[9];
        const [addr, p] = local.split(":");
        if (!p || p.toUpperCase() !== hexPort || !inode) continue;
        if (!anyAddr && addr !== "0100007F" && addr !== "00000000") continue;
        try {
          for (const pid of fs.readdirSync("/proc")) {
            if (!/^\d+$/.test(pid)) continue;
            let fds: string[] = [];
            try {
              fds = fs.readdirSync(`/proc/${pid}/fd`);
            } catch {
              continue;
            }
            for (const fd of fds) {
              try {
                if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`) return Number(pid);
              } catch {
                /* ignore */
              }
            }
          }
        } catch {
          /* ignore */
        }
      }
      return undefined;
    };
    return scan("/proc/net/tcp") ?? scan("/proc/net/tcp6", true);
  }
  if (process.platform === "win32") {
    const { spawn } = await import("node:child_process");
    const out = await new Promise<string>((resolve) => {
      const child = spawn("netstat", ["-ano", "-p", "tcp"], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      const bufs: Buffer[] = [];
      child.stdout?.on("data", (c: Buffer) => bufs.push(c));
      child.on("exit", () => resolve(Buffer.concat(bufs).toString("utf8")));
      child.on("error", () => resolve(""));
    });
    const needles = [`${host}:${port}`, `0.0.0.0:${port}`];
    for (const line of out.split(/\r?\n/)) {
      if (!needles.some((n) => line.includes(n))) continue;
      const cols = line.trim().split(/\s+/);
      const pid = Number(cols[cols.length - 1]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  }
  return undefined;
}

export async function signalOwnPort(port: number, apiKey: string): Promise<boolean> {
  if (!(await confirmOwnServer(port, apiKey))) return false;
  const pid = await pidListeningOnPort(port);
  if (!pid) return false;
  if (!(await confirmOwnServer(port, apiKey))) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const health = await checkHealth(port, apiKey, 400);
    if (health.status === "down") return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* gone */
  }
  const health = await checkHealth(port, apiKey, 400);
  return health.status === "down";
}
