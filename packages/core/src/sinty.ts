import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { SintyEvent } from "@sinty/sdk";
import { Agent } from "./agent.js";
import { Bus } from "./bus.js";
import { DEFAULT_AGENTS_MD, DEFAULT_CONFIG_YAML, DEFAULT_POLICY_YAML, loadConfig, loadPolicy, type SintyConfig, type SintyPolicy } from "./config.js";
import { PluginHost } from "./host/host.js";
import { newId } from "./ids.js";
import { Journal } from "./journal.js";
import { MemoryRouter } from "./memory-router.js";
import { ModelGateway } from "./models.js";
import { PatchManager } from "./patches.js";
import { createAgentBridge } from "./plugin-bridge.js";
import { checkIntegrity, installLooksStrictUnsafe } from "./integrity.js";
import { resolvePaths, type SintyPaths } from "./paths.js";
import { SecretStore } from "./secrets.js";
import { SupervisorClient } from "./supervisor-client.js";

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
  for (const dir of [paths.home, paths.blobs, paths.plugins, paths.skills, paths.workspace, paths.data]) {
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

const PLUGIN_ACTOR = { kind: "system", id: "patches" } as const;

export class Sinty {
  readonly paths: SintyPaths;
  readonly config: SintyConfig;
  readonly policy: SintyPolicy;
  readonly secrets: SecretStore;
  readonly journal: Journal;
  readonly bus = new Bus();
  readonly host: PluginHost;
  readonly patches: PatchManager;
  readonly supervisor: SupervisorClient | undefined;
  readonly agent: Agent;
  readonly memory: MemoryRouter;
  readonly models: ModelGateway;
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
      agent: createAgentBridge(() => ({ agent: this.agent, journal: this.journal, bus: this.bus })),
      models: (plugin, allowed, op, req) => this.models.pluginCall(plugin, allowed, op, req),
    });
    this.models = new ModelGateway({ config: this.config, secrets: this.secrets, host: this.host, record: (input) => this.agent.emit(input), log: this.log });

    this.patches = new PatchManager(this.paths, this.journal, this.host, {
      proposed: (p) => this.agent.emit({ sessionId: p.sessionId, type: "plugin.patch.proposed", actor: PLUGIN_ACTOR, data: { patchId: p.id, plugin: p.plugin, reason: p.reason, branch: `.staging/${p.id}` } }),
      tested: (p, ok) => this.agent.emit({ sessionId: p.sessionId, type: "plugin.patch.tested", actor: PLUGIN_ACTOR, data: { patchId: p.id, ok, output: p.testOutput } }),
      applied: (p) => this.agent.emit({ sessionId: p.sessionId, type: "plugin.patch.applied", actor: PLUGIN_ACTOR, data: { patchId: p.id, commit: p.commit ?? "" } }),
      rolledBack: (r) => this.agent.emit({ sessionId: r.sessionId, type: "plugin.patch.rolled_back", actor: PLUGIN_ACTOR, data: { patchId: r.patchId, toCommit: r.toCommit, reason: r.reason } }),
      toolsChanged: () => this.supervisor?.setTools(this.agent.supervisedTools()),
    });

    const s = this.config.supervisor;
    const budget = this.policy.budgets.turn;
    this.supervisor = s.enabled
      ? new SupervisorClient(
          this.paths,
          { loopThreshold: s.loopThreshold, maxNoticesPerTurn: s.maxNoticesPerTurn, maxNoticesPerDetector: 2, docsMaxChars: s.docsMaxChars, budget: { steps: budget.steps, tokens: budget.tokens } },
          () => this.journal.incidents(),
          {
            log: (level, msg) => this.log(level, msg),
            replay: () => this.openTurnEvents(),
            incidentResolved: (sessionId, turnId, incident) => {
              const row = this.journal.addIncident({ id: newId("inc"), ...incident });
              this.agent.emit({ sessionId, ...(turnId ? { turnId } : {}), type: "supervisor.incident_resolved", actor: { kind: "supervisor", id: "supervisor" }, data: { incidentId: row.id, tool: row.tool, code: row.code, fixSummary: row.fixSummary } });
              this.supervisor?.incidentStored(row);
            },
          },
        )
      : undefined;

    this.memory = new MemoryRouter({
      dataDir: this.paths.data,
      config: this.config,
      record: (input) => this.agent.emit(input),
      log: this.log,
      host: this.host,
      redact: (t) => this.secrets.redact(t),
      turnEvents: (turnId) => this.journal.turnEvents(turnId),
    });

    this.agent = new Agent({
      memory: this.memory,
      models: this.models,
      paths: this.paths,
      config: this.config,
      policy: this.policy,
      secrets: this.secrets,
      journal: this.journal,
      host: this.host,
      bus: this.bus,
      patches: this.patches,
      ...(this.supervisor ? { supervisor: this.supervisor } : {}),
      log: this.log,
    });
  }

  /** Starts plugins and the supervisor, then resumes turns that were running when the process stopped. */
  async start(): Promise<{ failedPlugins: { plugin: string; error: string }[]; resumedTurns: string[] }> {
    const integrity = checkIntegrity(this.paths.install);
    if (!integrity.ok) throw new Error(`install integrity check failed:\n${integrity.problems.slice(0, 8).join("\n")}`);
    if (this.policy.mode === "strict") {
      const note = installLooksStrictUnsafe();
      if (note && process.platform !== "win32" && note.includes("root")) throw new Error(note);
      if (note) this.log("warn", note);
    }
    const { failed } = await this.host.start();
    for (const f of failed) this.log("error", `plugin ${f.plugin} failed to start: ${f.error}`);
    if (this.supervisor) {
      this.supervisor.setTools(this.agent.supervisedTools());
      await this.supervisor.start();
    }
    this.memory.kick();
    const resumedTurns = this.agent.resumeAll();
    return { failedPlugins: failed, resumedTurns };
  }

  async stop(): Promise<void> {
    await this.agent.stop();
    this.supervisor?.stop();
    this.memory.beginClose();
    this.host.stop();
    await this.memory.close();
    this.journal.close();
  }

  private openTurnEvents(): SintyEvent[] {
    const turns = [...this.journal.turnsWithStatus("running"), ...this.journal.turnsWithStatus("blocked")];
    return turns.flatMap((t) => this.journal.turnEvents(t.id));
  }
}
