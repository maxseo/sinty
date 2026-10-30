import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isInside } from "./paths.js";
import { bwrapArgs, decideSandbox, type ShellSandboxConfig } from "./shell-sandbox.js";

const MAX_OUT = 20_000;

export interface ShellResult {
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface ShellOptions extends ShellSandboxConfig {
  /** policy mode strict: on Linux the command runs only inside bubblewrap. */
  strict?: boolean;
  /** $SINTY_HOME, kept out of the Linux sandbox. */
  home?: string;
  log?: (level: string, msg: string) => void;
  /**
   * Folders outside the workspace a human just allowed for this command. Read-only in the cage.
   * Anything else outside the workspace is still refused.
   */
  grants?: string[];
}

/** One warning per process when Linux commands run without the sandbox. */
let warnedUnsandboxed = false;

/**
 * Runs one command. The working directory stays inside the workspace. Output is capped. On Windows the command runs in
 * the AppContainer cage (ShellBox.exe); on Linux inside bubblewrap when available (see shell-sandbox.ts).
 */
export function runShell(workspace: string, command: string, cwd = ".", timeoutMs = 30_000, opts: ShellOptions = {}): Promise<ShellResult> {
  const line = command.trim();
  if (!line) return Promise.reject(new Error("command is empty"));
  if (line.length > 4_000) return Promise.reject(new Error("command is longer than 4000 characters"));
  const ms = Math.min(Math.max(timeoutMs, 1_000), 120_000);
  const dir = resolve(workspace, cwd);
  if (!isInside(dir, workspace)) return Promise.reject(new Error("cwd must stay inside the workspace"));
  const grants = opts.grants ?? [];
  try {
    assertSandbox(workspace, dir, line, grants, process.env, opts.home);
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  mkdirSync(dir, { recursive: true });

  const box = process.platform === "win32" ? shellBoxExe() : undefined;
  if (process.platform === "win32" && !box) return Promise.reject(new Error("command cage is missing"));
  const linux = process.platform === "linux" ? decideSandbox(opts, opts.strict) : undefined;
  if (linux?.kind === "refuse") return Promise.reject(new ShellSandboxError(linux.message));
  if (linux?.kind === "none" && opts.sandbox !== "off" && !warnedUnsandboxed) {
    warnedUnsandboxed = true;
    opts.log?.("warn", `shell.run runs without a sandbox (${linux.reason}); install bubblewrap or set shell.sandbox: off to silence this`);
  }
  const ws = resolve(workspace);
  return new Promise((done) => {
    const tools = box ? cageNode() : undefined;
    const child = box
      ? spawn(box, ["--cwd", dir, ...(tools ? ["--tools", tools] : []), ...grants.flatMap((g) => ["--grant", g]), "--command", line], { cwd: dir, windowsHide: true })
      : linux?.kind === "bwrap"
        ? spawn(linux.bin, bwrapArgs({ workspace: ws, cwd: dir, command: line, ...(opts.home ? { home: opts.home } : {}), ...(opts.network !== undefined ? { network: opts.network } : {}), ...(opts.passEnv ? { passEnv: opts.passEnv } : {}), ...(grants.length ? { grants } : {}) }), { cwd: dir })
        : spawn(line, { cwd: dir, shell: true, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const take = (chunk: Buffer, which: "out" | "err"): void => {
      if (which === "out") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
      if (stdout.length + stderr.length > MAX_OUT) {
        truncated = true;
        stdout = stdout.slice(0, MAX_OUT);
        stderr = stderr.slice(0, Math.max(0, MAX_OUT - stdout.length));
        killTree(child);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => take(chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => take(chunk, "err"));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, ms);
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ cwd: dir, exitCode: 1, stdout, stderr: e.message, truncated, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ cwd: dir, exitCode: code, stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), truncated, timedOut });
    });
  });
}

export class ShellSandboxError extends Error {}

/** A copy of Node the cage can execute. Program Files is not readable by the container, and granting it needs an administrator. */
function cageNode(): string | undefined {
  const source = process.execPath;
  const dir = join(process.env.LOCALAPPDATA ?? "", "Sinty", "cage-tools");
  if (!dir || dir === join("Sinty", "cage-tools")) return undefined;
  const plain = join(dir, "node.exe");
  if (existsSync(plain)) rmSync(plain);
  const target = join(dir, "node-real.exe");
  if (!existsSync(target)) {
    mkdirSync(dir, { recursive: true });
    const copied = spawnSync("cmd.exe", ["/d", "/c", "copy", "/Y", source, target], { windowsHide: true });
    if (copied.status !== 0) return undefined;
  }
  writeFileSync(
    join(dir, "node.cmd"),
    "@echo off\r\nif exist \"%~1\" (\r\n  type \"%~1\" | \"%~dp0node-real.exe\" -\r\n  exit /b %ERRORLEVEL%\r\n)\r\n\"%~dp0node-real.exe\" %*\r\n",
  );
  return dir;
}

/** Staged installs carry dist/sandbox/ShellBox.exe (scripts/stage.mjs); a source checkout has the tracked sandbox/ShellBox.exe. */
function shellBoxExe(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "sandbox", "ShellBox.exe"), join(here, "..", "sandbox", "ShellBox.exe")]) if (existsSync(p)) return p;
  return undefined;
}

const EXPAND_ENV = new Set(["LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]);

/**
 * Folders outside the workspace that this command names. A human may allow exactly these, for this command.
 * Throws when a named path is the disk, the user profile, or the Sinty home (secrets). Those are never granted.
 */
export function shellGrants(workspace: string, cwd: string, command: string, env: NodeJS.ProcessEnv = process.env, home?: string): string[] {
  const expanded = command.replace(/%([^%]+)%/g, (all, name: string) => {
    if (!EXPAND_ENV.has(name.toUpperCase())) return all;
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    return key && env[key] ? env[key] : all;
  });
  const profile = env.USERPROFILE ? resolve(env.USERPROFILE) : undefined;
  const grants: string[] = [];
  for (const ref of pathRefs(expanded)) {
    const abs = resolve(cwd, ref);
    const dir = grantDir(abs);
    if (isInside(abs, workspace) || isInside(dir, workspace)) continue;
    refuseWide(dir, home, profile);
    if (!grants.some((g) => isInside(dir, g) && isInside(g, dir))) grants.push(dir);
  }
  return grants;
}

/** Rejects a command that names a file outside the workspace and outside `grants`. */
export function assertSandbox(workspace: string, cwd: string, command: string, grants: readonly string[] = [], env?: NodeJS.ProcessEnv, home?: string): void {
  const needed = shellGrants(workspace, cwd, command, env, home);
  for (const dir of needed) {
    if (!grants.some((g) => isInside(dir, resolve(g)))) throw new Error(`command reaches outside the workspace: ${dir}`);
  }
}

function pathRefs(command: string): string[] {
  const refs: string[] = [];
  const rest = command.replace(/"([^"]*)"|'([^']*)'/g, (_all, dbl: string | undefined, sgl: string | undefined) => {
    const inner = (dbl ?? sgl ?? "").trim();
    if (looksLikePath(inner)) refs.push(inner);
    return " ";
  });
  for (const ref of rest.match(/[A-Za-z]:[\\/][^\s"'|&<>]*|\\\\[^\s"'|&<>]+|(?:\.\.?[\\/])+[^\s"'|&<>]+/g) ?? []) refs.push(ref);
  return refs;
}

function looksLikePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || /^(?:\.\.?[\\/])/.test(value);
}

function grantDir(abs: string): string {
  try {
    if (existsSync(abs) && statSync(abs).isFile()) return dirname(abs);
  } catch {
    // A path the process cannot stat is granted as named.
  }
  const ext = extname(abs);
  if (ext && ext.length > 1 && ext.length <= 5) return dirname(abs);
  return abs;
}

function refuseWide(dir: string, home: string | undefined, profile: string | undefined): void {
  if (dirname(dir) === dir) throw new Error(`command reaches outside the workspace: ${dir} (too wide)`);
  if (profile && (samePath(dir, profile) || isInside(profile, dir))) throw new Error(`command reaches outside the workspace: ${dir} (the user profile is too wide)`);
  if (home && (isInside(dir, home) || isInside(home, dir))) throw new Error(`command reaches outside the workspace: ${dir} (Sinty secrets are never granted)`);
  if (dir.split(/[\\/]/).some((part) => part.toLowerCase() === ".sinty")) throw new Error(`command reaches outside the workspace: ${dir} (Sinty secrets are never granted)`);
}

function samePath(a: string, b: string): boolean {
  return isInside(a, b) && isInside(b, a);
}

function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    const exe = join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "taskkill.exe");
    spawn(exe, ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" });
    return;
  }
  child.kill("SIGKILL");
}
