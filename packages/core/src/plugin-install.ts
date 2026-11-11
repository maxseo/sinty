import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, type SintyConfig } from "./config.js";
import type { PluginHost } from "./host/host.js";
import { parseManifest } from "./host/manifest.js";
import { markAgentMade } from "./agent-plugins.js";
import { enablePluginInConfig, forgetPluginInConfig, setPluginEnabledInConfig } from "./mcp-install.js";
import { isInside, type SintyPaths } from "./paths.js";
import { dropPluginFromRoster } from "./roster.js";

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
    config.plugins.disabled = (config.plugins.disabled ?? []).filter((n) => n !== name);
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

/**
 * Removes a managed home plugin from the library. The process stops and only its install folder goes away,
 * and config.yaml drops the plugin's settings. User data/secrets/shared dependencies stay. Bundled plugins can only be turned off.
 */
export async function removeHomePlugin(paths: SintyPaths, host: PluginHost, name: string): Promise<void> {
  const id = name.trim();
  if (!PLUGIN_NAME.test(id)) throw new PluginInstallError("bad_name", `plugin name ${id} is invalid`);
  if (existsSync(join(paths.bundledPlugins, id, "sinty.plugin.json"))) {
    throw new PluginInstallError("bundled", `плагин ${id} встроен в установку`, "Его можно выключить. Из библиотеки убираются только добавленные плагины.");
  }
  const homeDir = removableHomeDir(paths, id);
  setPluginEnabledInConfig(paths, id, false);
  await host.disable(id);
  removableHomeDir(paths, id); // Recheck after waiting for the process to exit.
  forgetPluginInConfig(paths, id);
  dropPluginFromRoster(paths, id);
  markAgentMade(paths, id, false);
  rmSync(resolve(homeDir), { recursive: true, force: true });
}

/** Library/UI hint; backend repeats all checks immediately before removal. */
export function canRemoveHomePlugin(paths: SintyPaths, name: string): boolean {
  try { removableHomeDir(paths, name); return true; } catch { return false; }
}

function removableHomeDir(paths: SintyPaths, name: string): string {
  if (!PLUGIN_NAME.test(name)) throw new PluginInstallError("bad_name", "invalid plugin name");
  if (existsSync(join(paths.bundledPlugins, name, "sinty.plugin.json"))) {
    throw new PluginInstallError("bundled", "Встроенный плагин можно только выключить");
  }
  const dir = join(paths.plugins, name);
  const manifest = join(dir, "sinty.plugin.json");
  if (!existsSync(manifest)) throw new PluginInstallError("not_found", "Плагин не установлен в управляемой библиотеке");
  const root = resolve(paths.plugins);
  // Refuse junctions/symlinks and redirected parents; never delete external/shared installs.
  if (lstatSync(root).isSymbolicLink() || lstatSync(dir).isSymbolicLink() || lstatSync(manifest).isSymbolicLink()
    || realpathSync(root) !== join(realpathSync(paths.home), "plugins")
    || realpathSync(dir) !== join(realpathSync(root), name)) {
    throw new PluginInstallError("unsafe_path", "Отказ удалить плагин по ссылке или вне управляемой папки");
  }
  const parsed = parseManifest(JSON.parse(readFileSync(manifest, "utf8")));
  if (parsed.name !== name) throw new PluginInstallError("bad_name", "Имя плагина не совпадает с папкой");
  // Otherwise discovery would expose a second install with the same name after removal.
  for (const search of hostSearchPaths(paths)) {
    const other = resolve(paths.home, search, name);
    if (resolve(other) !== resolve(dir) && existsSync(join(other, "sinty.plugin.json"))) {
      throw new PluginInstallError("external", "Есть другая установка с тем же именем в searchPaths; она не удаляется автоматически");
    }
  }
  return dir;
}

function hostSearchPaths(paths: SintyPaths): string[] {
  return loadConfig(paths).plugins.searchPaths;
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