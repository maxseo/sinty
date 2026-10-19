import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isInside } from "./paths.js";

const MAX_OUT = 20_000;

export interface ShellResult {
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

/** Runs one command. The working directory stays inside the workspace. Output is capped. */
export function runShell(workspace: string, command: string, cwd = ".", timeoutMs = 30_000): Promise<ShellResult> {
  const line = command.trim();
  if (!line) return Promise.reject(new Error("command is empty"));
  if (line.length > 4_000) return Promise.reject(new Error("command is longer than 4000 characters"));
  const ms = Math.min(Math.max(timeoutMs, 1_000), 120_000);
  const dir = resolve(workspace, cwd);
  if (!isInside(dir, workspace)) return Promise.reject(new Error("cwd must stay inside the workspace"));
  assertSandbox(workspace, dir, line);
  mkdirSync(dir, { recursive: true });

  const box = process.platform === "win32" ? shellBoxExe() : undefined;
  if (process.platform === "win32" && !box) return Promise.reject(new Error("command cage is missing"));
  return new Promise((done) => {
    const tools = box ? cageNode() : undefined;
    const child = box
      ? spawn(box, ["--cwd", dir, ...(tools ? ["--tools", tools] : []), "--command", line], { cwd: dir, windowsHide: true })
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
        child.kill();
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => take(chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => take(chunk, "err"));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
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

function shellBoxExe(): string | undefined {
  const nextToDist = join(dirname(fileURLToPath(import.meta.url)), "sandbox", "ShellBox.exe");
  return existsSync(nextToDist) ? nextToDist : undefined;
}

/** Rejects a command that names a file outside the workspace. The process still starts only after approval. */
export function assertSandbox(workspace: string, cwd: string, command: string): void {
  if (/%(USERPROFILE|HOMEPATH|HOME|APPDATA)%/i.test(command)) throw new Error("command refers to a profile folder outside the workspace");
  const refs = command.match(/[A-Za-z]:[\\/][^\s"'|&<>]+|\\\\[^\s"'|&<>]+|(?:\.\.?[\\/])+[^\s"'|&<>]+/g) ?? [];
  for (const ref of refs) {
    const abs = resolve(cwd, ref);
    if (!isInside(abs, workspace)) throw new Error(`command reaches outside the workspace: ${ref}`);
  }
}
