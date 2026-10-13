import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Agent } from "./agent.js";
import { Bus } from "./bus.js";
import { DEFAULT_AGENTS_MD, DEFAULT_CONFIG_YAML, DEFAULT_POLICY_YAML, loadConfig, loadPolicy, type SintyConfig, type SintyPolicy } from "./config.js";
import { PluginHost } from "./host/host.js";
import { Journal } from "./journal.js";
import { resolvePaths, type SintyPaths } from "./paths.js";
import { SecretStore } from "./secrets.js";

export type LogFn = (level: string, msg: string, data?: unknown) => void;

export interface InitResult {
  paths: SintyPaths;
  created: string[];
  apiToken?: string;
}

/** Creates `$SINTY_HOME` with config, policy, rules and an API token. Existing files are kept. */
export function initHome(home?: string): InitResult {
  const paths = resolvePaths(home);
  const created: string[] = [];
  for (const dir of [paths.home, paths.blobs, paths.plugins, paths.skills, paths.workspace]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }
  for (const [file, content] of [
    [paths.config, DEFAULT_CONFIG_YAML],
    [paths.policy, DEFAULT_POLICY_YAML],
    [paths.agents, DEFAULT_AGENTS_MD],
  ] as const) {
    if (!existsSync(file)) {
      writeFileSync(file, content);
      created.push(file);
    }
  }
  const secrets = new SecretStore(paths);
  let apiToken: string | undefined;
  if (!secrets.get("api.token")) {
    apiToken = `snt_${randomBytes(24).toString("base64url")}`;
    secrets.set("api.token", apiToken);
  }
  return { paths, created, ...(apiToken ? { apiToken } : {}) };
}

export interface SintyOptions {
  home?: string;
  log?: LogFn;
  /** Overrides on top of config.yaml, mainly for tests and embedding. */
  config?: Partial<SintyConfig>;
  policy?: Partial<SintyPolicy>;
}

export class Sinty {
  readonly paths: SintyPaths;
  readonly config: SintyConfig;
  readonly policy: SintyPolicy;
  readonly secrets: SecretStore;
  readonly journal: Journal;
  readonly bus = new Bus();
  readonly host: PluginHost;
  readonly agent: Agent;
  private readonly log: LogFn;

  constructor(opts: SintyOptions = {}) {
    this.paths = resolvePaths(opts.home);
    if (!existsSync(this.paths.home)) throw new Error(`${this.paths.home} does not exist; run: sinty init`);
    this.log = opts.log ?? (() => undefined);
    this.config = { ...loadConfig(this.paths), ...opts.config };
    this.policy = { ...loadPolicy(this.paths), ...opts.policy };
    this.secrets = new SecretStore(this.paths);
    this.journal = new Journal(this.paths.journal, (t) => this.secrets.redact(t));
    this.host = new PluginHost(this.paths, this.config, this.policy, this.secrets, {
      log: (plugin, level, msg, data) => this.log(level, `[${plugin}] ${msg}`, data),
      loaded: (plugin, version) => this.log("info", `plugin ${plugin}@${version} ready`),
      crashed: (plugin, code, restarts) => this.log("warn", `plugin ${plugin} exited with ${code} (crash ${restarts})`),
      readJournal: (sessionId, afterSeq, types) => this.journal.events(sessionId, { afterSeq, types }),
    });
    this.agent = new Agent({
      paths: this.paths,
      config: this.config,
      policy: this.policy,
      secrets: this.secrets,
      journal: this.journal,
      host: this.host,
      bus: this.bus,
      log: this.log,
    });
  }

  /** Starts plugins and resumes turns that were running when the process stopped. */
  async start(): Promise<{ failedPlugins: { plugin: string; error: string }[]; resumedTurns: string[] }> {
    const { failed } = await this.host.start();
    for (const f of failed) this.log("error", `plugin ${f.plugin} failed to start: ${f.error}`);
    const resumedTurns = this.agent.resumeAll();
    return { failedPlugins: failed, resumedTurns };
  }

  async stop(): Promise<void> {
    await this.agent.stop();
    this.host.stop();
    this.journal.close();
  }
}
