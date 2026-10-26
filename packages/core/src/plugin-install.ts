import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { SintyConfig } from "./config.js";
import type { PluginHost } from "./host/host.js";
import { parseManifest } from "./host/manifest.js";
import { enablePluginInConfig } from "./mcp-install.js";
import { isInside, type SintyPaths } from "./paths.js";

const PLUGIN_NAME = /^[a-z][a-z0-9-]{1,63}$/;
const RESERVED_FOLDERS = new Set([".staging", ".git", "node_modules"]);

export class PluginInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "PluginInstallError";
  }
}

export interface PluginInstallInput {
  /** Absolute or home-relative path to a folder that contains sinty.plugin.json. */
  path?: string;
  /** npm package name (or name@version). Packs without installing scripts into the host tree. */
  npm?: string;
  /** Replace an existing home plugin folder. Never replaces a bundled plugin. Default false. */
  replace?: boolean;
  /** Enable in config.yaml and hot-start. Default true. */
  enable?: boolean;
}

export interface PluginInstallResult {
  name: string;
  version: string;
  description: string;
  kinds: string[];
  location: "home";
  source: "path" | "npm";
  enabled: boolean;
  started: boolean;
  startError?: string;
  next?: string;
}

/** Lets home plugins `import "@sinty/sdk"` the same way plugin patches do. */
function ensureSdkLink(paths: SintyPaths): void {
  const link = join(paths.plugins, "node_modules", "@sinty", "sdk");
  if (existsSync(link)) return;
  const target = join(paths.install, "packages", "sdk");
  if (!existsSync(target)) return;
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}
/**
 * Copies a Sinty plugin folder into `$SINTY_HOME/plugins/<name>/`, optionally enables it,
 * and hot-starts via PluginHost.reload. Used by Settings → Plugins → Добавить.
 */
export async function installHomePlugin(
  paths: SintyPaths,
  config: SintyConfig,
  host: PluginHost,
  input: PluginInstallInput,
): Promise<PluginInstallResult> {
  const hasPath = typeof input.path === "string" && input.path.trim().length > 0;
  const hasNpm = typeof input.npm === "string" && input.npm.trim().length > 0;
  if (hasPath === hasNpm) {
    throw new PluginInstallError("bad_request", "pass exactly one of path or npm", "Example: { path: \"E:/plugins/my-tool\" } or { npm: \"@scope/sinty-plugin-x\" }.");
  }

  let source: "path" | "npm" = "path";
  let srcDir: string;
  let staging: string | undefined;
  try {
    if (hasNpm) {
      source = "npm";
      staging = mkdtempSync(join(tmpdir(), "sinty-plugin-npm-"));
      srcDir = await packNpm(input.npm!.trim(), staging);
    } else {
      srcDir = resolvePath(paths, input.path!.trim());
    }

    const manifestPath = join(srcDir, "sinty.plugin.json");
    if (!existsSync(manifestPath)) {
      throw new PluginInstallError("bad_manifest", `no sinty.plugin.json in ${srcDir}`, "Point at a Sinty plugin folder (or an npm package that ships one).");
    }

    let manifest;
    try {
      manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    } catch (e) {
      throw new PluginInstallError("bad_manifest", e instanceof Error ? e.message : String(e), "Fix sinty.plugin.json to match the schema.");
    }

    const name = manifest.name;
    if (!PLUGIN_NAME.test(name) || RESERVED_FOLDERS.has(name) || name.startsWith(".")) {
      throw new PluginInstallError("bad_name", `plugin name ${name} is invalid or reserved`);
    }

    const bundledDir = join(paths.bundledPlugins, name);
    if (existsSync(join(bundledDir, "sinty.plugin.json"))) {
      throw new PluginInstallError(
        "bundled",
        `plugin ${name} is a bundled plugin and cannot be overwritten`,
        "Pick another name, or fork with plugin.propose_patch.",
      );
    }

    const homeDir = join(paths.plugins, name);
    assertSafeHomeDir(paths, homeDir, name);

    // Refuse copying a folder that is already the home destination (noop / loop).
    if (resolve(srcDir) === resolve(homeDir) && !input.replace) {
      // Already installed at home: just enable/reload.
      ensureSdkLink(paths);
      return finishInstall(paths, config, host, manifest, source, input.enable !== false, false);
    }

    const replace = input.replace === true;
    if (existsSync(homeDir)) {
      if (!replace) {
        throw new PluginInstallError("exists", `plugin folder already exists at ${homeDir}`, "Pass replace: true to overwrite, or pick another name.");
      }
      await host.unload(name);
      rmSync(homeDir, { recursive: true, force: true });
    }

    mkdirSync(paths.plugins, { recursive: true });
    ensureSdkLink(paths);
    cpSync(srcDir, homeDir, {
      recursive: true,
      filter: (src) => {
        const base = basename(src);
        return base !== ".git" && base !== ".staging";
      },
    });

    return finishInstall(paths, config, host, manifest, source, input.enable !== false, true);
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}

async function finishInstall(
  paths: SintyPaths,
  config: SintyConfig,
  host: PluginHost,
  manifest: { name: string; version: string; description: string; kinds: string[] },
  source: "path" | "npm",
  enable: boolean,
  wrote: boolean,
): Promise<PluginInstallResult> {
  const name = manifest.name;
  let started = false;
  let startError: string | undefined;
  if (enable) {
    enablePluginInConfig(paths, name);
    if (!config.plugins.enabled.includes(name)) config.plugins.enabled = [...config.plugins.enabled, name];
    startError = await host.reload(name);
    started = !startError && Boolean(host.plugins.get(name));
  }
  return {
    name,
    version: manifest.version,
    description: manifest.description,
    kinds: [...manifest.kinds],
    location: "home",
    source,
    enabled: enable,
    started,
    ...(startError ? { startError } : {}),
    next: started
      ? wrote
        ? `Plugin ${name} installed under $SINTY_HOME/plugins and loaded.`
        : `Plugin ${name} was already at home; enabled and loaded.`
      : enable
        ? `Plugin ${name} was written/enabled; fix startError or restart sinty web.`
        : `Plugin ${name} copied to $SINTY_HOME/plugins (not enabled). Turn it on in Settings → Plugins.`,
  };
}

function resolvePath(paths: SintyPaths, raw: string): string {
  const resolved = resolve(raw);
  if (!existsSync(resolved)) {
    // Allow paths relative to $SINTY_HOME for convenience.
    const fromHome = resolve(paths.home, raw);
    if (existsSync(fromHome)) return fromHome;
    throw new PluginInstallError("not_found", `path not found: ${resolved}`);
  }
  return resolved;
}

function assertSafeHomeDir(paths: SintyPaths, homeDir: string, name: string): void {
  const resolved = resolve(homeDir);
  if (!isInside(resolved, paths.plugins) || resolved === resolve(paths.plugins)) {
    throw new PluginInstallError("bad_name", `refusing to write outside plugins home for ${name}`);
  }
}

/** `npm pack <spec>` into staging; returns the extracted package root (with sinty.plugin.json). */
async function packNpm(spec: string, staging: string): Promise<string> {
  if (!/^[A-Za-z0-9@/_.~+-]+$/.test(spec) || spec.includes("..") || spec.includes(" ") || spec.includes("\\")) {
    throw new PluginInstallError("bad_request", `suspicious npm package id ${JSON.stringify(spec)}`, "Use a plain package name like my-sinty-plugin or @scope/name.");
  }
  const pack = spawnSync("npm", ["pack", spec, "--pack-destination", staging, "--ignore-scripts"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (pack.status !== 0) {
    const err = (pack.stderr || pack.stdout || "").trim().slice(0, 500);
    throw new PluginInstallError("npm_failed", `npm pack failed for ${spec}`, err || "Is npm on PATH? Does the package exist?");
  }
  const tgz = readdirSync(staging).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new PluginInstallError("npm_failed", "npm pack produced no tarball");
  const extractDir = join(staging, "extract");
  mkdirSync(extractDir, { recursive: true });
  const tar = spawnSync("tar", ["-xzf", join(staging, tgz), "-C", extractDir], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  if (tar.status !== 0) {
    // Windows Node often has no tar.exe; fall back to npm's unpack via `npm install --ignore-scripts` into a prefix — heavier but portable.
    const prefix = join(staging, "prefix");
    mkdirSync(prefix, { recursive: true });
    const inst = spawnSync("npm", ["install", join(staging, tgz), "--prefix", prefix, "--ignore-scripts", "--no-save", "--no-package-lock"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
    });
    if (inst.status !== 0) {
      throw new PluginInstallError("npm_failed", "failed to extract npm pack tarball", (inst.stderr || tar.stderr || "").trim().slice(0, 500));
    }
    const nm = join(prefix, "node_modules");
    const scopes = existsSync(nm) ? readdirSync(nm) : [];
    for (const s of scopes) {
      if (s.startsWith(".")) continue;
      const p = join(nm, s);
      if (s.startsWith("@")) {
        for (const child of readdirSync(p)) {
          const cand = join(p, child);
          if (existsSync(join(cand, "sinty.plugin.json"))) return cand;
        }
      } else if (existsSync(join(p, "sinty.plugin.json"))) {
        return p;
      }
    }
    throw new PluginInstallError("bad_manifest", "npm package has no sinty.plugin.json after extract");
  }
  const pkgRoot = join(extractDir, "package");
  if (existsSync(join(pkgRoot, "sinty.plugin.json"))) return pkgRoot;
  throw new PluginInstallError("bad_manifest", "npm package has no sinty.plugin.json");
}