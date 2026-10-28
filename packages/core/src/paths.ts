import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface SintyPaths {
  home: string;
  install: string;
  config: string;
  policy: string;
  agents: string;
  secrets: string;
  secretKey: string;
  journal: string;
  /** Staff, roles and grants. Not the event journal. */
  accounts: string;
  blobs: string;
  plugins: string;
  bundledPlugins: string;
  skills: string;
  workspace: string;
  /** Per-plugin data folders: `data/<plugin>`. */
  data: string;
}

/** Files only the core may touch. A plugin permission covering any of them is rejected. */
export function coreOwnedPaths(p: SintyPaths): string[] {
  return [p.config, p.policy, p.agents, p.secrets, p.secretKey, p.journal, p.accounts, p.blobs, p.install];
}

/** Install root: `SINTY_INSTALL_ROOT`, else the nearest parent that has `integrity.json` or the repo workspace file. */
export function findInstallRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  if (process.env.SINTY_INSTALL_ROOT) return resolve(process.env.SINTY_INSTALL_ROOT);
  let dir = resolve(from);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "integrity.json")) || existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(from, "..", "..", "..");
}

export function resolvePaths(home?: string): SintyPaths {
  const h = resolve(home ?? process.env.SINTY_HOME ?? join(homedir(), ".sinty"));
  const install = findInstallRoot();
  return {
    home: h,
    install,
    config: join(h, "config.yaml"),
    policy: join(h, "policy.yaml"),
    agents: join(h, "AGENTS.md"),
    secrets: join(h, "secrets.json"),
    secretKey: join(h, "secret.key"),
    journal: join(h, "journal.db"),
    accounts: join(h, "accounts.db"),
    blobs: join(h, "blobs"),
    plugins: join(h, "plugins"),
    bundledPlugins: join(install, "plugins"),
    skills: join(h, "skills"),
    workspace: join(h, "workspace"),
    data: join(h, "data"),
  };
}

export function isInside(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

function normalize(path: string): string {
  const r = resolve(path);
  return process.platform === "win32" ? r.toLowerCase() : r;
}
