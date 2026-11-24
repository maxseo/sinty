import {catalogProof} from "./plugin-catalog-trust.js";
import {packageFingerprint} from "./plugin-recovery.js";
import {configPluginFlags,syncText,type UpdateReceipt} from "./plugin-recovery.js";
import { extractPluginArchive } from "./plugin-archive.js";
import { assertReleaseCompatibility, releaseHash, type ReleaseCompatibility } from "./plugin-release.js";
import { transactPluginDirectory, PluginTransactionError } from "./plugin-transaction.js";
import { parseDocument } from "yaml";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, lstatSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, type SintyConfig } from "./config.js";
import type { PluginHost } from "./host/host.js";
import { parseManifest } from "./host/manifest.js";
import { markAgentMade } from "./agent-plugins.js";
import { forgetPluginInConfig, setPluginEnabledInConfig } from "./mcp-install.js";
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
  /** Exact old/new permission fingerprints after owner review; never inferred from category. */
  permissionsReview?: { from: string; to: string };
  /** Enable in config.yaml and hot-start. Default true. */
  enable?: boolean;
}

export interface PluginInstallResult {
  name: string;
  version: string;
  description: string;
  kinds: string[];
  location: "home";
  source: "path" | "npm" | "catalog";
  enabled: boolean;
  started: boolean;
  startError?: string;
  trust?: "local-path-unverified" | "npm-registry-unverified" | "trusted-catalog";
  rollbackAvailable?: boolean;
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
  verifiedCatalogProof?: object,
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
    if (existsSync(srcDir) && lstatSync(srcDir).isSymbolicLink() || existsSync(manifestPath) && lstatSync(manifestPath).isSymbolicLink()) throw new PluginInstallError("unsafe_package", "Plugin source and manifest must not be links");
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
    const signed=catalogProof(verifiedCatalogProof);
    if(verifiedCatalogProof&&!signed)throw new PluginInstallError("catalog_proof_invalid","Invalid internal catalog provenance");
    if(signed&&(resolve(signed.dir)!==resolve(srcDir)||signed.name!==name||signed.version!==manifest.version||packageFingerprint(srcDir)!==signed.treeHash))throw new PluginInstallError("catalog_proof_stale","Verified package changed");
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

    mkdirSync(paths.plugins,{recursive:true});
    if(lstatSync(paths.plugins).isSymbolicLink()||realpathSync(paths.plugins)!==join(realpathSync(paths.home),"plugins"))throw new PluginInstallError("unsafe_plugin_path","Managed plugins root cannot escape its home");
    const homeDir = join(paths.plugins, name);
    assertSafeHomeDir(paths, homeDir, name);

    const sameHome=resolve(srcDir)===resolve(homeDir);
    const replace = input.replace === true || sameHome;
    if (existsSync(homeDir) && !replace) throw new PluginInstallError("exists", "plugin folder already exists", "Pass replace: true after reviewing the update.");
    if (existsSync(homeDir) && lstatSync(homeDir).isSymbolicLink() || existsSync(join(homeDir,"sinty.plugin.json")) && lstatSync(join(homeDir,"sinty.plugin.json")).isSymbolicLink()) throw new PluginInstallError("unsafe_package","Installed plugin cannot be a link");
    const previous = existsSync(join(homeDir,"sinty.plugin.json")) ? parseManifest(JSON.parse(readFileSync(join(homeDir,"sinty.plugin.json"),"utf8"))) : undefined;
    if(previous && releaseHash(previous.permissions)!==releaseHash(manifest.permissions)) {
      const from=releaseHash(previous.permissions),to=releaseHash(manifest.permissions);
      if(input.permissionsReview?.from!==from||input.permissionsReview?.to!==to)throw new PluginInstallError("permission_review_required","Updated plugin changes permissions",JSON.stringify({from,to}));
    }
    const metadata=manifest as typeof manifest & {compatibility?:ReleaseCompatibility};
    const release=JSON.parse(readFileSync(join(paths.install,"release.json"),"utf8")),sdk=JSON.parse(readFileSync(join(paths.install,"packages","sdk","package.json"),"utf8"));
    try{assertReleaseCompatibility(metadata.compatibility,{core:release.version,sdk:sdk.version,protocol:"sinty/1.0",platform:process.platform,arch:process.arch});}catch{throw new PluginInstallError("incompatible_plugin","Package is incompatible with current core/SDK/protocol/platform");}
    const on=config.plugins.enabled.includes(name),off=(config.plugins.disabled??[]).includes(name),running=host.plugins.has(name),enable=input.enable!==false;
    const onIndex=config.plugins.enabled.indexOf(name),offIndex=(config.plugins.disabled??[]).indexOf(name);
    const restoreFlags=():void=>{config.plugins.enabled=config.plugins.enabled.filter(n=>n!==name);if(on)config.plugins.enabled.splice(Math.min(onIndex,config.plugins.enabled.length),0,name);config.plugins.disabled=(config.plugins.disabled??[]).filter(n=>n!==name);if(off)config.plugins.disabled.splice(Math.min(offIndex,config.plugins.disabled.length),0,name)};
    ensureSdkLink(paths);
    const diskBefore=configPluginFlags(paths.config,name);
    const receipt:UpdateReceipt={version:manifest.version,...(previous?{previousVersion:previous.version}:{}),source,trust:source==="path"?"local-path-unverified":"npm-registry-unverified",signatureVerified:false,publisher:null};
    if(signed)Object.assign(receipt,{source:"catalog",trust:"trusted-catalog",signatureVerified:true,publisher:signed.publisher,artifactSha256:signed.artifactSha256,catalogUrl:signed.catalogUrl,catalogSequence:signed.catalogSequence,signatureScope:"catalog-index"});
    if(signed&&previous&&host.plugins.has(name)&&((previous as {updateMode?:string}).updateMode!=="rpc-only"||(host.plugins.get(name)?.loaded.manifest as {updateMode?:string}|undefined)?.updateMode!=="rpc-only"||(manifest as {updateMode?:string}).updateMode!=="rpc-only"))throw new PluginInstallError("plugin_restart_required","Active catalog update requires both lifecycle declarations");
    const maintenance=await host.beginUpdate(name);
    try {
      const tx=await transactPluginDirectory({root:paths.plugins,name,source:srcDir,dataRoot:paths.data,configPath:paths.config,configBefore:diskBefore,configAfter:enable?{enabled:true,disabled:false}:diskBefore,metadata:receipt,stop:()=>host.unload(name,maintenance.token),
        validate:dir=>{if(signed&&packageFingerprint(dir)!==signed.treeHash)throw new PluginInstallError("catalog_proof_stale","Verified staged package changed");const m=parseManifest(JSON.parse(readFileSync(join(dir,"sinty.plugin.json"),"utf8")));if(m.name!==name||releaseHash(m)!==releaseHash(manifest))throw new PluginInstallError("bad_manifest","Staged package metadata changed after review");if(previous&&releaseHash(parseManifest(JSON.parse(readFileSync(join(homeDir,"sinty.plugin.json"),"utf8"))))!==releaseHash(previous))throw new PluginInstallError("stale_update","Installed package changed during preparation; review again");const meta=m as typeof m & {changelog?:string};if(meta.changelog&&(!existsSync(join(dir,meta.changelog))||!lstatSync(join(dir,meta.changelog)).isFile()||lstatSync(join(dir,meta.changelog)).size>256*1024))throw new PluginInstallError("bad_changelog","Declared changelog must be an included file <=256 KiB");if(meta.changelog)receipt.changelog=readFileSync(join(dir,meta.changelog),"utf8").slice(0,8192);if(m.runtime==="node"&&!m.entry&&!m.kinds.every(k=>k==="ui"))throw new PluginInstallError("bad_entry","Node plugin requires an entry");if(m.runtime==="node"&&m.entry){const p=resolve(dir,m.entry);if(!isInside(p,dir)||!existsSync(p)||lstatSync(p).isSymbolicLink())throw new PluginInstallError("bad_entry","Node entry must be a package file");}},
        activate:async()=>{if(enable){config.plugins.enabled=[...new Set([...config.plugins.enabled,name])];config.plugins.disabled=(config.plugins.disabled??[]).filter(n=>n!==name);const error=await host.reload(name,maintenance.token);if(error||!host.plugins.has(name))throw new PluginInstallError("start_failed","New plugin failed readiness");}return {name,version:manifest.version,description:manifest.description,kinds:[...manifest.kinds],location:"home" as const,source,enabled:config.plugins.enabled.includes(name)&&!(config.plugins.disabled??[]).includes(name),started:enable}},
        commit:()=>{if(enable){const latest=configPluginFlags(paths.config,name);if(latest.enabled!==diskBefore.enabled||latest.disabled!==diskBefore.disabled)throw new PluginInstallError("stale_config","Plugin settings changed during update; review again");const doc=parseDocument(existsSync(paths.config)?readFileSync(paths.config,"utf8"):"");const arr=(k:string):string[]=>{const v=doc.getIn(["plugins",k]);return v&&typeof v==="object"&&"toJSON" in v?(v as {toJSON():string[]}).toJSON():[]};doc.setIn(["plugins","enabled"],[...new Set([...arr("enabled"),name])]);doc.setIn(["plugins","disabled"],arr("disabled").filter(n=>n!==name));syncText(paths.config,String(doc))}},
        restoreRuntime:async()=>{restoreFlags();if(running){const error=await host.reload(name,maintenance.token);if(error||!host.plugins.has(name))throw new Error("Previous runtime could not restart")}}
      });
      return {...tx.value,...(signed?{source:"catalog" as const}:{}),trust:signed?"trusted-catalog" as const:source==="path"?"local-path-unverified" as const:"npm-registry-unverified" as const,rollbackAvailable:!!tx.previous,next:signed?"Проверенная версия из подписанного каталога установлена; прежняя версия сохранена при обновлении.":tx.previous?"Previous package retained in managed rollback storage; source trust remains "+source:"Installed from "+source+" (not a signed catalog package)"};
    } catch(e) {restoreFlags();if(e instanceof PluginTransactionError){if(e.rollbackRestored===false)host.recoveryBlocked.set(name,e.code);throw new PluginInstallError(e.code,e.message,JSON.stringify({rollbackRestored:e.rollbackRestored??false}));}throw e;} finally {maintenance.release()}

  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
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
  try { extractPluginArchive(readFileSync(join(staging,tgz)),extractDir); } catch { throw new PluginInstallError("unsafe_archive","npm package archive rejected; only bounded materialized regular-file tar packages are supported"); }
  const pkgRoot = join(extractDir, "package");
  if (existsSync(join(pkgRoot, "sinty.plugin.json"))) return pkgRoot;
  throw new PluginInstallError("bad_manifest", "npm package has no sinty.plugin.json");
}