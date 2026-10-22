import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { isInside } from "./paths.js";

/**
 * Linux sandbox for `shell.run` with bubblewrap (`bwrap`): the command sees the system folders and the tool folders on
 * PATH read-only, the workspace read-write, an empty /tmp, no home folder (so no `~/.sinty` secrets, SSH keys or
 * browser profiles), no network by default and only a short list of environment variables. This is the Linux
 * counterpart of the Windows command cage (sandbox/ShellBox.exe, an AppContainer without capabilities).
 */

export type ShellSandboxMode = "auto" | "bwrap" | "off";

export interface ShellSandboxConfig {
  /** `auto` (default): bubblewrap when it works, otherwise run as before with a warning (refused in strict mode). `bwrap`: required. `off`: never. */
  sandbox?: ShellSandboxMode | undefined;
  /** Let the command reach the network. Default false, like the Windows cage. */
  network?: boolean | undefined;
  /** Extra environment variable names passed into the sandbox. `SINTY_SECRET_*` are never passed. */
  passEnv?: string[] | undefined;
}

export type SandboxDecision = { kind: "bwrap"; bin: string } | { kind: "none"; reason: string } | { kind: "refuse"; message: string };

/** Variables a command usually needs; everything else, API keys and SINTY_SECRET_* included, stays outside. */
const BASE_ENV = ["PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TERM", "TZ"];

/** System folders bound read-only when present; a merged-/usr symlink (/bin → usr/bin) is recreated as a symlink. */
const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/opt"];

const probes = new Map<string, { ok: boolean; error: string }>();

/** Forgets the cached bubblewrap probe (tests). */
export function resetSandboxProbe(): void {
  probes.clear();
}

/** `bwrap` on PATH, or undefined. `SINTY_BWRAP` names another binary (tests, unusual installs). */
export function findBwrap(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.SINTY_BWRAP !== undefined) return env.SINTY_BWRAP && existsSync(env.SINTY_BWRAP) ? env.SINTY_BWRAP : undefined;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, "bwrap");
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Whether bubblewrap can create its namespaces here: some containers and hardened kernels forbid unprivileged user
 * namespaces (`kernel.unprivileged_userns_clone=0`, AppArmor `restrict_unprivileged_userns`). Cached per binary.
 */
export function probeBwrap(bin: string): { ok: boolean; error: string } {
  const hit = probes.get(bin);
  if (hit) return hit;
  const r = spawnSync(bin, ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "--", "/bin/sh", "-c", "exit 0"], { encoding: "utf8", timeout: 10_000 });
  const res = r.status === 0 ? { ok: true, error: "" } : { ok: false, error: (r.error?.message ?? r.stderr ?? "").trim().split("\n")[0] || `exit ${r.status}` };
  probes.set(bin, res);
  return res;
}

/** What `shell.run` does on this machine. Only Linux has a bubblewrap sandbox; other platforms answer `none`. */
export function decideSandbox(cfg: ShellSandboxConfig = {}, strict = false, platform: NodeJS.Platform = process.platform): SandboxDecision {
  if (platform !== "linux") return { kind: "none", reason: `no bubblewrap sandbox on ${platform}` };
  const mode = cfg.sandbox ?? "auto";
  if (mode === "off") return { kind: "none", reason: "shell.sandbox: off" };
  const bin = findBwrap();
  const probe = bin ? probeBwrap(bin) : { ok: false, error: "bwrap not found on PATH" };
  if (bin && probe.ok) return { kind: "bwrap", bin };
  if (mode === "bwrap" || strict) {
    const why = mode === "bwrap" ? "shell.sandbox: bwrap" : "policy mode strict";
    return {
      kind: "refuse",
      message: `the bubblewrap sandbox is not available (${probe.error}) and ${why} requires it. Install bubblewrap (apt install bubblewrap, dnf install bubblewrap) or set shell.sandbox: off in config.yaml`,
    };
  }
  return { kind: "none", reason: `bubblewrap unavailable: ${probe.error}` };
}

export interface BwrapCommand {
  workspace: string;
  cwd: string;
  command: string;
  /** The Sinty home ($SINTY_HOME): a PATH entry at or above it is never bound. */
  home?: string;
  network?: boolean;
  passEnv?: string[];
  env?: NodeJS.ProcessEnv;
}

/** Arguments for `bwrap` that run `command` with `/bin/sh -c` inside the sandbox. */
export function bwrapArgs(o: BwrapCommand): string[] {
  const env = o.env ?? process.env;
  const args = ["--die-with-parent", "--new-session", "--unshare-all"];
  if (o.network) args.push("--share-net");
  for (const d of SYSTEM_DIRS) {
    if (!existsSync(d)) continue;
    const st = lstatSync(d);
    if (st.isSymbolicLink()) args.push("--symlink", readlinkSync(d), d);
    else args.push("--ro-bind", d, d);
  }
  // With network, /etc/resolv.conf may point into /run (systemd-resolved, NetworkManager).
  if (o.network) for (const d of ["/run/systemd/resolve", "/run/NetworkManager", "/run/resolvconf"]) if (existsSync(d)) args.push("--ro-bind", d, d);
  args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");

  // Tool folders on PATH (Node itself, nvm, ~/.local/bin, …), read-only, so the same commands work inside.
  const blocked = [safeReal(o.workspace), ...(o.home ? [o.home] : []), ...(env.HOME ? [env.HOME] : [])];
  const tools = new Set<string>();
  const nodeDir = safeReal(dirname(process.execPath));
  const addTool = (dir: string): void => {
    if (!dir || !isAbsolute(dir) || !existsSync(dir)) return;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (real === "/" || SYSTEM_DIRS.some((s) => isInside(real, s))) return;
    // Never a folder that contains the workspace, the Sinty home or the user's home: that would expose all of it.
    if (blocked.some((b) => isInside(b, real))) return;
    // Inside the workspace it is visible already, read-write.
    if (isInside(real, o.workspace)) return;
    // Inside the Sinty home only the Node that runs Sinty (a bundled install); secrets.json and memory.db stay out.
    if (o.home && isInside(real, o.home) && real !== nodeDir) return;
    tools.add(real);
  };
  addTool(dirname(process.execPath));
  for (const dir of (env.PATH ?? "").split(delimiter)) addTool(dir);
  for (const t of tools) args.push("--ro-bind", t, t);

  // Real paths: a symlink on the way to the workspace would not exist inside the sandbox.
  const ws = safeReal(o.workspace);
  args.push("--bind", ws, ws, "--chdir", join(ws, relative(o.workspace, o.cwd)));
  args.push("--clearenv");
  const names = new Set([...BASE_ENV, ...(o.passEnv ?? [])]);
  for (const n of names) {
    if (n.startsWith("SINTY_SECRET_")) continue;
    const v = env[n];
    if (v !== undefined) args.push("--setenv", n, v);
  }
  args.push("--setenv", "HOME", ws, "--setenv", "TMPDIR", "/tmp");
  args.push("--", "/bin/sh", "-c", o.command);
  return args;
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
