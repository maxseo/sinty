import {ReleaseChecks} from "./release-checks.js";
import {recoverPluginTransactions} from "./plugin-recovery.js";
import { createWebToolsPilotDriver } from "./web-pilot-driver.js";
import { BrowserPilot, type BrowserPilotDriver } from "./browser-pilot.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { SintyEvent } from "@sinty/sdk";
import { Agent } from "./agent.js";
import { newApiToken } from "./api-token.js";
import { Bus } from "./bus.js";
import { scrubText, type SupervisorSettings } from "@sinty/supervisor";
import { DEFAULT_AGENTS_MD, DEFAULT_CONFIG_YAML, DEFAULT_POLICY_YAML, effectiveBudget, loadConfig, loadPolicy, withDefaultPlugins, type SintyConfig, type SintyPolicy } from "./config.js";
import { PluginHost } from "./host/host.js";
import { newId } from "./ids.js";
import { Accounts } from "./accounts.js";
import { Journal } from "./journal.js";
import { MemoryRouter } from "./memory-router.js";
import { ModelGateway } from "./models.js";
import { ContextWindows } from "./context-window.js";
import { enablePluginInConfig } from "./mcp-install.js";
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
    apiToken = newApiToken();
    secrets.set("api.token", apiToken);
  }
  return { paths, created, ...(apiToken ? { apiToken } : {}) };
}

export interface ManagedRuntime {testFeedOrigin?:string;applicationVersion?:string;buildHash?:string;root:string;version:string;sha256:string;instance:string;gate:{readonly blocked:boolean;enter():()=>void}}
export interface SintyOptions {
  managed?:ManagedRuntime;
  /** Internal embedding/test adapter only; no default native adapter until verified on an isolated fixture. */
  browserPilotDriver?: BrowserPilotDriver;
  /** Owner-launcher opt-in. Does not create a browser until an authenticated pilot task prepares one. */
  browserPilotWebTools?: boolean;
  home?: string;
  log?: LogFn;
  /** Overrides on top of config.yaml, mainly for tests and embedding. */
  config?: Partial<SintyConfig>;
  policy?: Partial<SintyPolicy>;
}

const PLUGIN_ACTOR = { kind: "system", id: "patches" } as const;

export class Sinty {
  /** Unknown transaction ownership/corruption keeps the core UI available but prevents work. */
  pluginRecoveryIssue: string | null = null;
  retryPluginRecovery(){return recoverPluginTransactions(this.paths.plugins,{dataRoot:this.paths.data,configPath:this.paths.config})}

  readonly managed:ManagedRuntime|undefined;
  readonly paths: SintyPaths;
  readonly config: SintyConfig;
  readonly policy: SintyPolicy;
  readonly secrets: SecretStore;
  readonly journal: Journal;
  readonly accounts: Accounts;
  readonly bus = new Bus();
  readonly host: PluginHost;
  readonly patches: PatchManager;
  readonly supervisor: SupervisorClient | undefined;
  readonly agent: Agent;
  readonly browserPilot: BrowserPilot;
  readonly memory: MemoryRouter;
  readonly models: ModelGateway;
  readonly windows: ContextWindows;
  private readonly log: LogFn;

  constructor(opts: SintyOptions = {}) {
    this.managed=opts.managed;
    this.paths = resolvePaths(opts.home);if(opts.managed)this.paths.managedRoot=opts.managed.root;
    if (!existsSync(this.paths.home)) throw new Error(`${this.paths.home} does not exist; run: sinty init`);
    this.log = opts.log ?? (() => undefined);
    this.config = withDefaultPlugins({ ...loadConfig(this.paths), ...opts.config });
    const webPilot = opts.browserPilotWebTools !== undefined ? opts.browserPilotWebTools && this.config.plugins.enabled.includes("tool-web") && !(this.config.plugins.disabled ?? []).includes("tool-web") : this.config.plugins.enabled.includes("tool-browser") && !(this.config.plugins.disabled ?? []).includes("tool-browser");
    this.browserPilot = new BrowserPilot(this.paths.data, opts.browserPilotDriver ?? (webPilot ? createWebToolsPilotDriver(this.paths.data) : undefined), () => !!opts.browserPilotDriver || opts.browserPilotWebTools !== undefined || !!this.host?.plugins.has("tool-browser"));
    if (webPilot) this.log("info", "Browser backend enabled (owned public browser + local fixture; browser not started)");
    this.policy = { ...loadPolicy(this.paths), ...opts.policy };
    this.secrets = new SecretStore(this.paths);
    this.journal = new Journal(this.paths.journal, (t) => this.secrets.redact(t));
    this.accounts = new Accounts(this.paths.accounts);
    this.host = new PluginHost(this.paths, this.config, this.policy, this.secrets, {
      log: (plugin, level, msg, data) => this.log(level, `[${plugin}] ${msg}`, data),
      loaded: (plugin, version) => this.log("info", `plugin ${plugin}@${version} ready`),
      crashed: (plugin, code, restarts) => this.log("warn", `plugin ${plugin} exited with ${code} (crash ${restarts})`),
      readJournal: (sessionId, afterSeq, types) => this.journal.events(sessionId, { afterSeq, types }),
      agent: createAgentBridge(() => ({ agent: this.agent, journal: this.journal, bus: this.bus })),
      models: (plugin, allowed, op, req) => this.models.pluginCall(plugin, allowed, op, req),
    });
    this.models = new ModelGateway({
      config: this.config,
      secrets: this.secrets,
      host: this.host,
      record: (input) => this.agent.emit(input),
      log: this.log,
      usage: { get: (plugin, day) => this.journal.pluginModelUsage(plugin, day), add: (plugin, day, tokens) => void this.journal.addPluginModelUsage(plugin, day, tokens) },
    });

    this.patches = new PatchManager(this.paths, this.journal, this.host, {
      proposed: (p) => this.agent.emit({ sessionId: p.sessionId, type: "plugin.patch.proposed", actor: PLUGIN_ACTOR, data: { patchId: p.id, plugin: p.plugin, reason: p.reason, branch: `.staging/${p.id}` } }),
      tested: (p, ok) => this.agent.emit({ sessionId: p.sessionId, type: "plugin.patch.tested", actor: PLUGIN_ACTOR, data: { patchId: p.id, ok, output: p.testOutput } }),
      applied: (p) => this.agent.emit({ sessionId: p.sessionId, type: "plugin.patch.applied", actor: PLUGIN_ACTOR, data: { patchId: p.id, commit: p.commit ?? "" } }),
      rolledBack: (r) => this.agent.emit({ sessionId: r.sessionId, type: "plugin.patch.rolled_back", actor: PLUGIN_ACTOR, data: { patchId: r.patchId, toCommit: r.toCommit, reason: r.reason } }),
      toolsChanged: () => this.supervisor?.setTools(this.agent.supervisedTools()),
      enable: (name) => {
        enablePluginInConfig(this.paths, name);
        if (!this.config.plugins.enabled.includes(name)) this.config.plugins.enabled = [...this.config.plugins.enabled, name];
      },
    });

    // Incident memory written before arguments were masked may hold typed passwords or whole files: scrub it once.
    const scrubbed = this.journal.scrubIncidents((t) => scrubText(t));
    if (scrubbed) this.log("info", `supervisor: masked ${scrubbed} stored incident(s)`);
    // Until tool-web kept its error codes, every web failure was `web_failed`, and any later web call that worked
    // was stored as its "fix" (another site's url offered as the fix for a 429). Drop those incidents once.
    this.journal.once("2026-10-21-drop-web-failed-incidents", () => {
      const dropped = this.journal.dropIncidents((i) => i.tool.startsWith("web.") && i.code === "web_failed");
      if (dropped) this.log("info", `supervisor: dropped ${dropped} web.* web_failed incident(s) recorded by the old fix rule`);
    });
    this.supervisor = this.config.supervisor.enabled
      ? new SupervisorClient(
          this.paths,
          this.supervisorSettings(),
          () => this.journal.incidents(),
          {
            log: (level, msg) => this.log(level, msg),
            replay: () => this.openTurnEvents(),
            incidentResolved: (sessionId, turnId, incident) => {
              const row = this.journal.addIncident({ id: newId("inc"), tool: incident.tool, code: incident.code, message: this.secrets.redact(scrubText(incident.message)), fixSummary: this.secrets.redact(scrubText(incident.fixSummary)) });
              this.agent.emit({ sessionId, ...(turnId ? { turnId } : {}), type: "supervisor.incident_resolved", actor: { kind: "supervisor", id: "supervisor" }, data: { incidentId: row.id, tool: row.tool, code: row.code, fixSummary: row.fixSummary } });
              this.supervisor?.incidentStored(row);
            },
          },
        )
      : undefined;

    this.windows = new ContextWindows({ dataDir: this.paths.data, config: this.config, host: this.host, secrets: this.secrets, log: this.log });
    this.memory = new MemoryRouter({
      dataDir: this.paths.data,
      config: this.config,
      record: (input) => this.agent.emit(input),
      log: this.log,
      host: this.host,
      redact: (t) => this.secrets.redact(t),
      turnEvents: (turnId) => this.journal.turnEvents(turnId),
      sessionEvents: (sessionId, types) => this.journal.events(sessionId, { types }),
      // Vector search in the builtin store turns on when models.routes.embed is configured.
      embedder: () => (this.models.hasRoute("embed") ? { embed: async (texts, signal) => (await this.models.embed({ input: texts, signal })).vectors } : undefined),
    });

    this.agent = new Agent({
      browserPilot: this.browserPilot,
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
      windows: this.windows,
      log: this.log,
    });
  }

  /** Supervisor process settings from config.yaml `supervisor` (budget numbers fall back to policy.yaml). */
  supervisorSettings(): SupervisorSettings {
    const s = this.config.supervisor;
    const b = effectiveBudget(this.config, this.policy);
    return {
      loopThreshold: s.loopThreshold,
      ...(s.loopBlockAfter !== undefined ? { loopBlockAfter: s.loopBlockAfter } : {}),
      maxNoticesPerTurn: s.maxNoticesPerTurn,
      maxNoticesPerDetector: s.maxNoticesPerDetector,
      docsMaxChars: s.docsMaxChars,
      escalate: s.escalate,
      repeatFailures: s.repeatFailures,
      patchAfterTurns: s.patchAfterTurns,
      useIncidents: s.useIncidents,
      checks: { ...s.checks },
      budget: { steps: b.steps, tokens: b.tokens, warnAt: b.warnAt, count: b.count, cachedWeight: b.cachedWeight },
    };
  }

  /** Starts plugins and the supervisor, then resumes turns that were running when the process stopped. */
  /** `background: false` (offline tools such as `sinty memory eval`) starts plugins only: no supervisor, no resumed turns, no memory queue. */
  private managedRequests=0;
  beginManagedRequest():()=>void{if(this.managed?.gate.blocked)throw Error("instance_draining");this.managedRequests++;let done=false;return()=>{if(!done){done=true;this.managedRequests--}}}
  get managedBusy():number{return (this.supervisor?.activeManagedCheckpoints??0)+this.models.activeManagedCalls+this.managedRequests+this.agent.activeManagedTurns+this.memory.activeManagedJobs+[...this.host.plugins.values()].reduce((n,p)=>n+p.inFlight,0)+(this.reembed?1:0)}
  assertManagedLifecycle():void{for(const p of this.host.plugins.values()){const m=p.loaded.manifest as typeof p.loaded.manifest&{updateMode?:string};if(m.entry&&!(m.updateMode==="rpc-only"&&!m.kinds.some(k=>["schedule","channel","server","event"].includes(k)))&&!(m.updateMode==="lifecycle"&&p.lifecycleReady))throw Error("managed_plugin_lifecycle_requires_review:"+m.name)}}
  private managedPaused=new Set<import("./host/host.js").PluginProcess>();
  async pauseManaged():Promise<void>{this.assertManagedLifecycle();for(const p of this.host.plugins.values()){if((p.loaded.manifest as typeof p.loaded.manifest&{updateMode?:string}).updateMode==="lifecycle"){this.managedPaused.add(p);await p.lifecycle("pause")}}}
  async resumeManaged():Promise<void>{const errors=[];for(const p of this.managedPaused){try{await p.lifecycle("resume");this.managedPaused.delete(p)}catch(e){errors.push(e)}}if(errors.length)throw Error("managed_resume_requires_owner_review")}
  private updateChecks:ReleaseChecks|undefined;
  getReleaseChecks(){return this.updateChecks??=new ReleaseChecks(this,this.managed?.testFeedOrigin?{loopbackOrigin:this.managed.testFeedOrigin}:undefined)}
  async start(opts: { background?: boolean } = {}): Promise<{ failedPlugins: { plugin: string; error: string }[]; resumedTurns: string[] }> {
    const integrity = checkIntegrity(this.paths.install);
    if (!integrity.ok) throw new Error(`install integrity check failed:\n${integrity.problems.slice(0, 8).join("\n")}`);
    if (this.policy.mode === "strict") {
      const note = installLooksStrictUnsafe();
      if (note && process.platform !== "win32" && note.includes("root")) throw new Error(note);
      if (note) this.log("warn", note);
    }
    let recovery:ReturnType<typeof recoverPluginTransactions>={repaired:[],blocked:[],configRepairs:[]};
    try{recovery=this.retryPluginRecovery()}catch(e){this.pluginRecoveryIssue=e instanceof Error&&/^[a-z_]+$/.test(e.message)?e.message:"plugin_recovery_requires_review";for(const name of this.config.plugins.enabled)if(name!=="ui-web")this.host.recoveryBlocked.set(name,this.pluginRecoveryIssue);this.log("error","Plugin recovery-only startup: "+this.pluginRecoveryIssue)}
    for(const b of recovery.blocked)this.host.recoveryBlocked.set(b.name,b.reason);
    for(const r of recovery.configRepairs){this.config.plugins.enabled=this.config.plugins.enabled.filter(n=>n!==r.name);if(r.flags.enabled)this.config.plugins.enabled.push(r.name);this.config.plugins.disabled=(this.config.plugins.disabled??[]).filter(n=>n!==r.name);if(r.flags.disabled)this.config.plugins.disabled.push(r.name)}
    const { failed } = await this.host.start();
    for (const f of failed) this.log("error", `plugin ${f.plugin} failed to start: ${f.error}`);
    if (opts.background === false || this.pluginRecoveryIssue) return { failedPlugins: failed, resumedTurns: [] };
    this.getReleaseChecks().start();
    if (this.supervisor) {
      this.supervisor.setTools(this.agent.supervisedTools());
      await this.supervisor.start();
    }
    this.memory.kick();
    this.windows.warm();
    if (this.config.memory.reembed === "auto" && this.models.hasRoute("embed")) this.reembedInBackground();
    const resumedTurns = this.agent.resumeAll();
    return { failedPlugins: failed, resumedTurns };
  }

  /**
   * Stops turns, lets the memory afterTurn queue drain while plugins still run (default: memory.hooks.closeTimeoutMs),
   * then stops plugins. Jobs that do not finish in time stay pending and resume on the next start.
   */
  async stop(opts: { drainTimeoutMs?: number } = {}): Promise<void> {
    this.updateChecks?.stop();
    this.reembed?.controller.abort();
    await this.reembed?.done;
    await this.agent.stop();
    await this.browserPilot.stop();
    try {
      await this.memory.drainBeforeClose(opts.drainTimeoutMs);
    } catch (e) {
      this.log("warn", "memory afterTurn queue was not drained before shutdown", e instanceof Error ? e.message : e);
    }
    this.supervisor?.stop();
    this.memory.beginClose();
    this.host.stop();
    await this.memory.close();
    this.journal.close();
    this.accounts.close();
  }

  private reembed: { controller: AbortController; done: Promise<void> } | undefined;

  /** memory.reembed: auto. Never fails the start; a stop aborts it between batches. */
  private reembedInBackground(): void {
    const controller = new AbortController();
    const done = this.memory
      .reindexVectors({ signal: controller.signal })
      .then((r) => {
        if (r.embedded || r.rebuilt) this.log("info", `memory: re-embedded ${r.embedded} of ${r.total} fact(s)${r.rebuilt ? " after rebuilding facts_vec" : ""}`);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) this.log("warn", "memory: background re-embed failed", e instanceof Error ? e.message : e);
      });
    this.reembed = { controller, done };
  }

  private openTurnEvents(): SintyEvent[] {
    const turns = [...this.journal.turnsWithStatus("running"), ...this.journal.turnsWithStatus("blocked")];
    return turns.flatMap((t) => this.journal.turnEvents(t.id));
  }
}
