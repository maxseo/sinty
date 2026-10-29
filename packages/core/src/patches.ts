import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import type { PluginManifest } from "@sinty/sdk";
import { agentMadePlugins, agentManifestViolations, markAgentMade } from "./agent-plugins.js";
import { git, hasGit } from "./git.js";
import { newId } from "./ids.js";
import type { PluginHost } from "./host/host.js";
import { parseManifest, type LoadedManifest } from "./host/manifest.js";
import type { Journal, PatchFile, PatchRow } from "./journal.js";
import type { SintyPaths } from "./paths.js";

export class PatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "PatchError";
  }
}

export interface PatchEvents {
  proposed(p: PatchRow): void;
  tested(p: PatchRow, ok: boolean): void;
  applied(p: PatchRow): void;
  rolledBack(p: { sessionId: string; patchId: string; plugin: string; toCommit: string; reason: string }): void;
  toolsChanged(): void;
  /** A new plugin was applied: add it to config.yaml plugins.enabled before it starts. */
  enable?(plugin: string): void;
}

const MAX_FILES = 20;
const MAX_FILE_BYTES = 200_000;
const TEST_TIMEOUT_MS = 60_000;
const CANARY_CALLS = 5;
const CANARY_MAX_FAILURES = 2;
const CANARY_CODES = new Set(["plugin_error", "plugin_crashed", "timeout", "plugin_unavailable"]);
const SKIP = new Set(["node_modules", "dist", ".git"]);
const PLUGIN_NAME = /^[a-z][a-z0-9-]{1,63}$/;

interface Canary {
  patchId: string;
  sessionId: string;
  baseCommit: string;
  calls: number;
  failures: number;
}

/** The only path by which agent-written code reaches a running plugin. */
export class PatchManager {
  private readonly canaries = new Map<string, Canary>();
  private repoReady = false;

  constructor(
    private readonly paths: SintyPaths,
    private readonly journal: Journal,
    private readonly host: PluginHost,
    private readonly events: PatchEvents,
  ) {}

  list(): { name: string; version: string; location: "bundled" | "home"; editable: boolean; tools: string[]; disabled: boolean }[] {
    return [...this.host.plugins.values()].map((p) => ({
      name: p.name,
      version: p.loaded.manifest.version,
      location: p.loaded.bundled ? "bundled" : "home",
      editable: p.loaded.manifest.editable !== false,
      tools: p.tools.map((t) => t.name),
      disabled: p.disabled,
    }));
  }

  read(plugin: string, path?: string): unknown {
    const loaded = this.locate(plugin);
    if (!path) return { plugin, location: loaded.bundled ? "bundled" : "home", files: listFiles(loaded.dir) };
    const abs = this.inside(loaded.dir, path);
    if (!existsSync(abs) || statSync(abs).isDirectory()) throw new PatchError("not_found", `${path} does not exist in ${plugin}`, "Call plugin.read without path to list files.");
    const text = readFileSync(abs, "utf8");
    if (text.length > MAX_FILE_BYTES) throw new PatchError("too_large", `${path} is larger than ${MAX_FILE_BYTES} bytes`);
    return { plugin, path, content: text };
  }

  /**
   * A new plugin written by the agent: same staging, tests and apply as a patch, under the narrower rules of
   * agent-plugins.ts. Applying it always needs a human, because it brings its first permissions.
   */
  async create(sessionId: string, input: { plugin: string; reason: string; files: PatchFile[] }): Promise<PatchRow> {
    const name = input.plugin;
    if (!PLUGIN_NAME.test(name)) throw new PatchError("bad_name", `plugin name must match ${PLUGIN_NAME}`, "Use a lowercase id like weather or price-check.");
    if (this.exists(name) || existsSync(join(this.paths.plugins, name))) throw new PatchError("exists", `plugin ${name} already exists`, "Pick another name, or change it with plugin.propose_patch.");
    this.checkFiles(input.files);
    if (!input.files.some((f) => normalize(f.path) === "sinty.plugin.json")) throw new PatchError("bad_patch", "a new plugin needs sinty.plugin.json", "See docs/spec/plugin-rules.md.");

    this.ensureSdkLink();
    const id = newId("pat");
    const staging = join(this.paths.plugins, ".staging", id, name);
    mkdirSync(staging, { recursive: true });
    writeFiles(staging, input.files);
    const row = this.newRow(id, name, sessionId, input);
    row.permissionsChanged = true;
    this.events.proposed(row);

    let manifest: PluginManifest;
    try {
      manifest = parseManifest(JSON.parse(readFileSync(join(staging, "sinty.plugin.json"), "utf8")));
      if (manifest.name !== name) throw new Error(`manifest name must be "${name}"`);
    } catch (e) {
      return this.finishTest(row, false, `manifest: ${e instanceof Error ? e.message : String(e)}`);
    }
    const bad = agentManifestViolations(manifest);
    if (bad.length) return this.finishTest(row, false, `rules for agent-written plugins:\n- ${bad.join("\n- ")}`);
    const { ok, output } = await this.test({ dir: staging, manifest, bundled: false, agentMade: true });
    return this.finishTest(row, ok, output);
  }

  /** True when the patch brings a plugin that does not exist yet. */
  isCreation(patchId: string): boolean {
    const p = this.journal.getPatch(patchId);
    return Boolean(p && p.status !== "applied" && !this.exists(p.plugin));
  }

  async propose(sessionId: string, input: { plugin: string; reason: string; files: PatchFile[] }): Promise<PatchRow> {
    const loaded = this.locate(input.plugin);
    if (loaded.manifest.editable === false) throw new PatchError("not_editable", `plugin ${input.plugin} is marked editable: false`, "Ask the human to change it.");
    this.checkFiles(input.files);

    this.ensureSdkLink();
    const id = newId("pat");
    const staging = join(this.paths.plugins, ".staging", id, input.plugin);
    copyPlugin(loaded.dir, staging);
    if (loaded.bundled) adaptForkedManifest(staging);
    writeFiles(staging, input.files);
    const row = this.newRow(id, input.plugin, sessionId, input);
    this.events.proposed(row);

    let manifest: PluginManifest;
    try {
      manifest = parseManifest(JSON.parse(readFileSync(join(staging, "sinty.plugin.json"), "utf8")));
      if (manifest.name !== input.plugin) throw new Error(`manifest name must stay "${input.plugin}"`);
    } catch (e) {
      return this.finishTest(row, false, `manifest: ${e instanceof Error ? e.message : String(e)}`);
    }
    row.permissionsChanged = stable(manifest.permissions) !== stable(loaded.manifest.permissions);
    if (loaded.agentMade) {
      const bad = agentManifestViolations(manifest);
      if (bad.length) return this.finishTest(row, false, `rules for agent-written plugins:\n- ${bad.join("\n- ")}`);
    }

    const { ok, output } = await this.test({ dir: staging, manifest, bundled: false, ...(loaded.agentMade ? { agentMade: true } : {}) });
    return this.finishTest(row, ok, output);
  }

  private newRow(id: string, plugin: string, sessionId: string, input: { reason: string; files: PatchFile[] }): PatchRow {
    return {
      id,
      plugin,
      sessionId,
      status: "ready",
      reason: input.reason,
      files: input.files,
      permissionsChanged: false,
      testOutput: "",
      baseCommit: null,
      commit: null,
      createdAt: new Date().toISOString(),
    };
  }

  private checkFiles(files: PatchFile[]): void {
    if (!files.length || files.length > MAX_FILES) throw new PatchError("bad_patch", `a patch must change 1–${MAX_FILES} files`);
    for (const f of files) {
      this.checkRelPath(f.path);
      if (Buffer.byteLength(f.content) > MAX_FILE_BYTES) throw new PatchError("too_large", `${f.path} is larger than ${MAX_FILE_BYTES} bytes`);
    }
  }

  private exists(plugin: string): boolean {
    try {
      this.host.locate(plugin);
      return true;
    } catch {
      return false;
    }
  }

  getPatch(id: string): PatchRow | undefined {
    return this.journal.getPatch(id);
  }

  async apply(patchId: string): Promise<{ applied: boolean; commit?: string; error?: string }> {
    const p = this.journal.getPatch(patchId);
    if (!p) throw new PatchError("not_found", `patch ${patchId} not found`);
    if (p.status !== "ready") throw new PatchError("not_ready", `patch ${patchId} is ${p.status}`, p.status === "failed_tests" ? "Fix the problems from the test output and propose a new patch." : undefined);
    const staging = join(this.paths.plugins, ".staging", p.id, p.plugin);
    if (!existsSync(staging)) throw new PatchError("not_found", `staging copy of ${patchId} is gone; propose the patch again`);

    await this.ensureRepo();
    const dest = join(this.paths.plugins, p.plugin);
    const created = !this.exists(p.plugin);
    const loaded = created ? undefined : this.locate(p.plugin);
    if (loaded?.bundled) {
      copyPlugin(loaded.dir, dest);
      adaptForkedManifest(dest);
      await git(this.paths.plugins, "add", "-A", "--", p.plugin);
      await git(this.paths.plugins, "commit", "-q", "--allow-empty", "-m", `fork ${p.plugin}@${loaded.manifest.version} from bundled`);
    }
    const baseCommit = await git(this.paths.plugins, "rev-parse", "HEAD");
    await this.host.unload(p.plugin);
    rmSync(dest, { recursive: true, force: true });
    copyPlugin(staging, dest);
    await git(this.paths.plugins, "add", "-A", "--", p.plugin);
    await git(this.paths.plugins, "commit", "-q", "--allow-empty", "-m", `patch ${p.id} ${p.plugin}: ${p.reason.slice(0, 200)}`);
    const commit = await git(this.paths.plugins, "rev-parse", "HEAD");
    p.baseCommit = baseCommit;
    p.commit = commit;
    if (created) {
      markAgentMade(this.paths, p.plugin, true);
      this.events.enable?.(p.plugin);
    }

    const err = await this.host.reload(p.plugin);
    if (err) {
      await this.restore(p.plugin, baseCommit, `patch ${p.id} did not start: ${err}`);
      p.status = "rolled_back";
      this.journal.savePatch(p);
      this.events.rolledBack({ sessionId: p.sessionId, patchId: p.id, plugin: p.plugin, toCommit: baseCommit, reason: `new version did not start: ${err}` });
      return { applied: false, error: err };
    }
    p.status = "applied";
    this.journal.savePatch(p);
    rmSync(join(this.paths.plugins, ".staging", p.id), { recursive: true, force: true });
    this.canaries.set(p.plugin, { patchId: p.id, sessionId: p.sessionId, baseCommit, calls: 0, failures: 0 });
    this.events.applied(p);
    this.events.toolsChanged();
    return { applied: true, commit };
  }

  /** Watches the first calls after a patch; rolls back if the plugin keeps failing. */
  async observe(plugin: string, outcome: { ok: true } | { ok: false; code: string }): Promise<void> {
    const c = this.canaries.get(plugin);
    if (!c) return;
    c.calls++;
    if (!outcome.ok && CANARY_CODES.has(outcome.code)) c.failures++;
    if (c.failures >= CANARY_MAX_FAILURES) {
      this.canaries.delete(plugin);
      const reason = `${c.failures} of the first ${c.calls} calls failed after patch ${c.patchId}`;
      await this.restore(plugin, c.baseCommit, reason);
      const p = this.journal.getPatch(c.patchId);
      if (p) {
        p.status = "rolled_back";
        this.journal.savePatch(p);
      }
      this.events.rolledBack({ sessionId: c.sessionId, patchId: c.patchId, plugin, toCommit: c.baseCommit, reason });
      this.events.toolsChanged();
    } else if (c.calls >= CANARY_CALLS) {
      this.canaries.delete(plugin);
    }
  }

  /** Human escape hatch: put a plugin back to a commit, or to the bundled version when it did not exist there. */
  async restore(plugin: string, commit: string, reason: string): Promise<void> {
    const dest = join(this.paths.plugins, plugin);
    const existed = (await git(this.paths.plugins, "ls-tree", "-d", "--name-only", commit, "--", plugin).catch(() => "")) !== "";
    await this.host.unload(plugin);
    rmSync(dest, { recursive: true, force: true });
    if (existed) await git(this.paths.plugins, "checkout", commit, "--", plugin);
    else if (agentMadePlugins(this.paths).has(plugin)) markAgentMade(this.paths, plugin, false);
    await git(this.paths.plugins, "add", "-A", "--", plugin);
    await git(this.paths.plugins, "commit", "-q", "--allow-empty", "-m", `rollback ${plugin} to ${commit.slice(0, 8)}: ${reason.slice(0, 200)}`);
    await this.host.reload(plugin);
  }

  private finishTest(row: PatchRow, ok: boolean, output: string): PatchRow {
    row.status = ok ? "ready" : "failed_tests";
    row.testOutput = output.slice(-8000);
    this.journal.savePatch(row);
    this.events.tested(row, ok);
    return row;
  }

  private async test(loaded: LoadedManifest): Promise<{ ok: boolean; output: string }> {
    const out: string[] = [];
    let proc;
    try {
      proc = await this.host.startDetached(loaded);
    } catch (e) {
      return { ok: false, output: `load: ${e instanceof Error ? e.message : String(e)}` };
    }
    out.push(`load: ok, tools [${proc.tools.map((t) => t.name).join(", ")}], providers [${proc.providers.join(", ")}]`);
    const args = proc.permissionArgs();
    const env = proc.childEnv();
    await proc.stopAndWait();

    const tests = listFiles(loaded.dir).filter((f) => /\.test\.(ts|js|mjs)$/.test(f));
    let ok = true;
    for (const file of tests) {
      const r = await runSandboxed(process.execPath, [...args, join(loaded.dir, file)], loaded.dir, env);
      out.push(`${file}: ${r.code === 0 ? "pass" : `FAIL (exit ${r.code})`}\n${r.output.trim()}`);
      if (r.code !== 0) ok = false;
    }
    if (!tests.length) out.push("no *.test.ts files; only the load check ran");
    return { ok, output: out.join("\n") };
  }

  private async ensureRepo(): Promise<void> {
    if (this.repoReady) return;
    if (!(await hasGit())) throw new PatchError("git_missing", "git is required for plugin patches", "Install git on this machine.");
    mkdirSync(this.paths.plugins, { recursive: true });
    if (!existsSync(join(this.paths.plugins, ".git"))) {
      writeFileSync(join(this.paths.plugins, ".gitignore"), "node_modules/\n.staging/\ndist/\n");
      await git(this.paths.plugins, "init", "-q");
      await git(this.paths.plugins, "add", "-A");
      await git(this.paths.plugins, "commit", "-q", "--allow-empty", "-m", "init plugin repository");
    }
    this.repoReady = true;
  }

  /** Lets plugins in $SINTY_HOME/plugins import @sinty/sdk from the install. */
  private ensureSdkLink(): void {
    const link = join(this.paths.plugins, "node_modules", "@sinty", "sdk");
    if (existsSync(link)) return;
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(this.paths.install, "packages", "sdk"), link, process.platform === "win32" ? "junction" : "dir");
  }

  private locate(plugin: string): LoadedManifest {
    try {
      return this.host.locate(plugin);
    } catch {
      throw new PatchError("not_found", `plugin ${plugin} not found`, "Use plugin.list to see installed plugins.");
    }
  }

  private checkRelPath(p: string): void {
    const n = normalize(p);
    const parts = n.split(/[\\/]/);
    if (!p || n.startsWith("..") || /^[a-zA-Z]:|^[\\/]/.test(p) || parts.some((x) => x === ".." || SKIP.has(x))) {
      throw new PatchError("bad_path", `${p} must be a relative path inside the plugin folder (not node_modules, dist or .git)`);
    }
  }

  private inside(dir: string, p: string): string {
    this.checkRelPath(p);
    return join(dir, normalize(p));
  }
}

function writeFiles(dir: string, files: PatchFile[]): void {
  for (const f of files) {
    const abs = join(dir, normalize(f.path));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
}

function copyPlugin(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, filter: (src) => !relative(from, src).split(sep).some((x) => SKIP.has(x)) });
}

/** Forked bundled plugins run from source through Node's type stripping, so no build step is needed. */
function adaptForkedManifest(dir: string): void {
  const file = join(dir, "sinty.plugin.json");
  const m = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (typeof m.entry === "string" && m.entry.startsWith("dist/") && existsSync(join(dir, "src", "index.ts"))) {
    m.entry = "src/index.ts";
    writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  }
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(abs, base));
    else out.push(relative(base, abs).split(sep).join("/"));
  }
  return out.sort();
}

function runSandboxed(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    let output = "";
    const add = (b: Buffer): void => {
      output = (output + b.toString()).slice(-6000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      output += `\n[killed after ${TEST_TIMEOUT_MS} ms]`;
      child.kill();
    }, TEST_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}
