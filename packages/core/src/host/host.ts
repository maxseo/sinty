import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentScope, ChatMessage, ContextInput, EventType, LiveEvent, PluginManifest, ProviderChunk, RecoverOutcome, SintyEvent } from "@sinty/sdk";
import type { SintyConfig, SintyPolicy } from "../config.js";
import type { SintyPaths } from "../paths.js";
import type { SecretStore } from "../secrets.js";
import { findPlugin, pluginDataDir, resolveFsGrants, type LoadedManifest } from "./manifest.js";
import type { AgentOp, CallCtx, FromChild, ProviderWireRequest, RouteInfo, ToChild, ToolInfo, WireError } from "./protocol.js";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "runner.js");
const READY_TIMEOUT_MS = 15_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const HTTP_START_TIMEOUT_MS = 120_000;
const CRASH_WINDOW_MS = 10 * 60_000;
const MAX_CRASHES = 5;
const AGENT_OP_SCOPE: Record<AgentOp | "stream", AgentScope> = {
  listSessions: "sessions.read",
  getSession: "sessions.read",
  events: "sessions.read",
  stream: "sessions.read",
  createSession: "sessions.write",
  send: "sessions.write",
  interrupt: "sessions.write",
};
const NO_BODY_STATUS = new Set([101, 204, 205, 304]);
const HOP_HEADERS = new Set(["authorization", "cookie", "connection", "keep-alive", "transfer-encoding", "host"]);

export type ToolOutcome = { ok: true; content: unknown } | { ok: false; error: WireError };

/** What plugins with `permissions.agent` may do; implemented by the core. */
export interface AgentBridge {
  call(plugin: string, op: AgentOp, args: unknown[]): Promise<unknown>;
  /** Replays the journal after `afterSeq`, then pushes live events. Returns the unsubscribe function. */
  stream(sessionId: string, afterSeq: number, push: (e: LiveEvent) => void): () => void;
}

export interface HostEvents {
  log(plugin: string, level: string, msg: string, data?: unknown): void;
  loaded(plugin: string, version: string): void;
  crashed(plugin: string, exitCode: number | null, restarts: number): void;
  readJournal(sessionId: string, afterSeq?: number, types?: EventType[]): SintyEvent[];
  agent?: AgentBridge;
}

interface Pending {
  onMessage(msg: FromChild): void;
  onCrash(error: WireError): void;
}

export interface RegisteredTool extends ToolInfo {
  plugin: string;
}

/** One plugin = one OS process under the Node.js permission model. */
export class PluginProcess {
  private child: ChildProcess | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private crashes: number[] = [];
  private stopping = false;
  private restarting: Promise<void> | undefined;
  autoRestart = true;
  disabled = false;
  tools: ToolInfo[] = [];
  providers: string[] = [];
  contexts: { name: string; order: number }[] = [];
  subscriptions: (EventType | "*")[] = [];
  routes: RouteInfo[] = [];
  /** A `ui`-only plugin without an entry: the core serves its files, no process runs. */
  staticOnly = false;
  private readonly streams = new Map<number, () => void>();

  constructor(
    readonly loaded: LoadedManifest,
    private readonly paths: SintyPaths,
    private readonly config: SintyConfig,
    private readonly policy: SintyPolicy,
    private readonly secrets: SecretStore,
    private readonly events: HostEvents,
  ) {}

  get name(): string {
    return this.loaded.manifest.name;
  }

  async start(): Promise<void> {
    const m = this.loaded.manifest;
    if (!m.entry && m.kinds.every((k) => k === "ui")) {
      if (!m.ui) throw new Error(`plugin ${m.name}: a ui plugin without entry needs "ui": { "static": "<folder>" }`);
      this.staticOnly = true;
      this.events.loaded(this.name, m.version);
      return;
    }
    if (m.runtime !== "node" && m.runtime !== "mcp-stdio" && m.runtime !== "http") throw new Error(`plugin ${m.name}: runtime ${m.runtime} is not supported by this core version yet`);
    if (m.runtime === "node" && !m.entry) throw new Error(`plugin ${m.name}: entry is required`);
    const child = fork(RUNNER, [], { execArgv: this.permissionArgs(), env: this.childEnv(), cwd: this.loaded.dir, stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "advanced" });
    this.child = child;
    child.stdout?.on("data", (b: Buffer) => this.events.log(this.name, "info", b.toString().trimEnd()));
    child.stderr?.on("data", (b: Buffer) => this.events.log(this.name, "warn", b.toString().trimEnd()));
    child.on("message", (msg: FromChild) => this.onMessage(msg));
    child.on("exit", (code) => this.onExit(code));

    const ready = new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error(`plugin ${this.name}: no ready within ${READY_TIMEOUT_MS} ms`)), READY_TIMEOUT_MS);
      const onMsg = (msg: FromChild): void => {
        if (msg.t === "ready") {
          clearTimeout(timer);
          child.off("message", onMsg);
          this.tools = msg.tools;
          this.providers = msg.providers;
          this.contexts = msg.contexts;
          this.subscriptions = msg.subscriptions;
          this.routes = msg.routes;
          resolveReady();
        } else if (msg.t === "fatal") {
          clearTimeout(timer);
          child.off("message", onMsg);
          reject(new Error(`plugin ${this.name}: ${msg.error.message}`));
        }
      };
      child.on("message", onMsg);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`plugin ${this.name}: exited with ${code} during start`));
      });
    });

    this.send({
      t: "init",
      manifest: m,
      entry: m.entry ? resolve(this.loaded.dir, m.entry) : "",
      config: { ...(m.config ?? {}), ...(this.config.plugins.config[m.name] ?? {}) },
      secrets: this.resolveSecrets(),
      net: { manifest: [...(m.permissions.net ?? []), ...(httpHost(m) ? [httpHost(m)!] : [])], policy: this.netPolicy() },
      paths: { workspace: this.paths.workspace, skills: this.paths.skills, plugin: this.loaded.dir, data: pluginDataDir(this.paths, m.name) },
    });
    await ready;
    this.events.loaded(this.name, m.version);
  }

  /** Node flags that confine a process to this plugin's grants; also used to run the plugin's tests. */
  permissionArgs(): string[] {
    const grants = resolveFsGrants(this.paths, this.loaded);
    for (const w of grants.write) mkdirSync(w, { recursive: true });
    return [
      "--permission",
      `--allow-fs-read=${this.paths.install}`,
      `--allow-fs-read=${this.loaded.dir}`,
      `--allow-fs-read=${join(this.paths.plugins, "node_modules")}`,
      ...grants.read.map((p) => `--allow-fs-read=${p}`),
      ...grants.write.flatMap((p) => [`--allow-fs-read=${p}`, `--allow-fs-write=${p}`]),
      ...(this.loaded.manifest.permissions.shell || this.loaded.manifest.runtime === "mcp-stdio" ? ["--allow-child-process"] : []),
      "--disable-warning=ExperimentalWarning",
    ];
  }

  childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const k of ["NODE_ENV", "PATH", "SYSTEMROOT", "TEMP", "TMP", ...(this.loaded.manifest.permissions.env ?? [])]) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
    env.SINTY_USER_ID = this.config.agent.userId;
    env.SINTY_AGENT_NAME = this.config.agent.name;
    env.SINTY_MEMORY_DIM = String(this.config.memory.dimensions);
    return env;
  }

  /** Resolves when the process has exited. */
  async stopAndWait(): Promise<void> {
    const c = this.child;
    if (!c || c.exitCode !== null) {
      this.stopping = true;
      return;
    }
    const exited = new Promise<void>((r) => c.once("exit", () => r()));
    this.stop();
    await exited;
  }

  stop(): void {
    this.stopping = true;
    if (this.child && this.child.exitCode === null) {
      this.send({ t: "shutdown" });
      const c = this.child;
      setTimeout(() => c.exitCode === null && c.kill(), 2000).unref();
    }
  }

  forward(event: SintyEvent): void {
    if (this.subscriptions.includes("*") || this.subscriptions.includes(event.type)) this.send({ t: "event", event });
  }

  async callTool(name: string, args: unknown, ctx: CallCtx, opts: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined; onProgress?: ((p: { message?: string; ratio?: number }) => void) | undefined }): Promise<ToolOutcome> {
    await this.whenRunning();
    const id = ++this.nextId;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    return new Promise<ToolOutcome>((resolveOutcome) => {
      let done = false;
      const finish = (o: ToolOutcome): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        resolveOutcome(o);
      };
      const timer = setTimeout(() => {
        this.send({ t: "cancel", id });
        finish({ ok: false, error: { code: "timeout", message: `tool ${name} did not finish in ${timeoutMs} ms`, hint: "Try smaller input or a different approach." } });
      }, timeoutMs);
      const onAbort = (): void => {
        this.send({ t: "cancel", id });
        finish({ ok: false, error: { code: "aborted", message: "turn interrupted" } });
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        onMessage: (msg) => {
          if (msg.t === "tool.progress") opts.onProgress?.({ ...(msg.message ? { message: msg.message } : {}), ...(msg.ratio !== undefined ? { ratio: msg.ratio } : {}) });
          else if (msg.t === "tool.result") finish(msg.ok ? { ok: true, content: msg.content } : { ok: false, error: msg.error });
        },
        onCrash: (error) => finish({ ok: false, error }),
      });
      if (!this.send({ t: "tool.run", id, name, args, ctx })) finish({ ok: false, error: { code: "plugin_unavailable", message: `plugin ${this.name} is not running` } });
    });
  }

  async recover(name: string, ctx: CallCtx): Promise<RecoverOutcome> {
    await this.whenRunning();
    const id = ++this.nextId;
    return new Promise((resolveOutcome) => {
      const timer = setTimeout(() => finish({ status: "unknown" }), 15_000);
      const finish = (o: RecoverOutcome): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolveOutcome(o);
      };
      this.pending.set(id, {
        onMessage: (msg) => msg.t === "tool.recovered" && finish(msg.outcome as RecoverOutcome),
        onCrash: () => finish({ status: "unknown" }),
      });
      if (!this.send({ t: "tool.recover", id, name, ctx })) finish({ status: "unknown" });
    });
  }

  async *streamProvider(protocol: string, req: ProviderWireRequest, signal: AbortSignal): AsyncGenerator<ProviderChunk> {
    await this.whenRunning();
    const id = ++this.nextId;
    const queue: (ProviderChunk | { end: true } | { error: WireError })[] = [];
    let wake: (() => void) | undefined;
    const push = (item: (typeof queue)[number]): void => {
      queue.push(item);
      wake?.();
    };
    this.pending.set(id, {
      onMessage: (msg) => {
        if (msg.t === "provider.chunk") push(msg.chunk);
        else if (msg.t === "provider.end") push({ end: true });
        else if (msg.t === "provider.error") push({ error: msg.error });
      },
      onCrash: (error) => push({ error }),
    });
    const onAbort = (): void => {
      this.send({ t: "cancel", id });
      push({ error: { code: "aborted", message: "turn interrupted" } });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (!this.send({ t: "provider.stream", id, protocol, req })) throw new ProviderError({ code: "plugin_unavailable", message: `plugin ${this.name} is not running` });
      for (;;) {
        if (queue.length === 0) await new Promise<void>((r) => (wake = r));
        wake = undefined;
        const item = queue.shift()!;
        if ("end" in item) return;
        if ("error" in item) throw new ProviderError(item.error);
        yield item;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.pending.delete(id);
    }
  }

  /** Forwards an HTTP request to one of the plugin's routes; the response body streams back chunk by chunk. */
  async handleHttp(route: number, params: Record<string, string>, req: Request, relativeUrl: string): Promise<Response> {
    await this.whenRunning();
    const id = ++this.nextId;
    const body = req.method === "GET" || req.method === "HEAD" ? null : new Uint8Array(await req.arrayBuffer());
    const headers = [...req.headers.entries()].filter(([k]) => !HOP_HEADERS.has(k.toLowerCase()));
    return new Promise<Response>((resolveResponse) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let started = false;
      let bodyless = false;
      let finished = false;
      const cleanup = (): void => {
        finished = true;
        clearTimeout(timer);
        this.pending.delete(id);
        req.signal.removeEventListener("abort", onAbort);
      };
      const fail = (status: number, error: WireError): void => {
        if (finished) return;
        cleanup();
        if (!started) resolveResponse(Response.json({ error }, { status }));
        else controller?.error(new Error(error.message));
      };
      const onAbort = (): void => {
        if (finished) return;
        this.send({ t: "cancel", id });
        cleanup();
        controller?.error(new Error("client disconnected"));
      };
      const timer = setTimeout(() => {
        if (started) return;
        this.send({ t: "cancel", id });
        fail(504, { code: "timeout", message: `plugin ${this.name} did not answer in ${HTTP_START_TIMEOUT_MS} ms` });
      }, HTTP_START_TIMEOUT_MS);
      req.signal.addEventListener("abort", onAbort, { once: true });
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
        cancel: () => onAbort(),
      });
      this.pending.set(id, {
        onMessage: (msg) => {
          if (msg.t === "http.start") {
            started = true;
            clearTimeout(timer);
            bodyless = NO_BODY_STATUS.has(msg.status) || req.method === "HEAD";
            resolveResponse(new Response(bodyless ? null : stream, { status: msg.status, headers: msg.headers }));
          } else if (msg.t === "http.chunk") {
            if (!bodyless) controller?.enqueue(msg.chunk);
          } else if (msg.t === "http.end") {
            cleanup();
            if (!bodyless) controller?.close();
          } else if (msg.t === "http.error") {
            fail(msg.error.code === "not_found" ? 404 : 502, msg.error);
          }
        },
        onCrash: (error) => fail(502, error),
      });
      if (!this.send({ t: "http.request", id, route, params, method: req.method, url: relativeUrl, headers, body })) {
        fail(503, { code: "plugin_unavailable", message: `plugin ${this.name} is not running` });
      }
    });
  }

  private hasScope(op: AgentOp | "stream"): boolean {
    return (this.loaded.manifest.permissions.agent ?? []).includes(AGENT_OP_SCOPE[op]);
  }

  private onAgentCall(id: number, op: AgentOp, args: unknown[]): void {
    const bridge = this.events.agent;
    if (!bridge || !this.hasScope(op)) {
      this.send({ t: "agent.result", id, ok: false, error: { code: "agent_denied", message: `plugin ${this.name} lacks permissions.agent "${AGENT_OP_SCOPE[op]}" for ${op}` } });
      return;
    }
    bridge
      .call(this.name, op, Array.isArray(args) ? args : [])
      .then((value) => this.send({ t: "agent.result", id, ok: true, value }))
      .catch((e: unknown) => this.send({ t: "agent.result", id, ok: false, error: wireOf(e) }));
  }

  private onAgentStream(id: number, sessionId: string, afterSeq: number): void {
    const bridge = this.events.agent;
    if (!bridge || !this.hasScope("stream")) {
      this.send({ t: "agent.end", id, error: { code: "agent_denied", message: `plugin ${this.name} lacks permissions.agent "sessions.read"` } });
      return;
    }
    try {
      this.streams.set(id, bridge.stream(String(sessionId), Number(afterSeq) || 0, (event) => this.send({ t: "agent.event", id, event })));
    } catch (e) {
      this.send({ t: "agent.end", id, error: wireOf(e) });
    }
  }

  async runContext(name: string, input: ContextInput): Promise<ChatMessage[]> {
    await this.whenRunning();
    const id = ++this.nextId;
    return new Promise((resolveMessages, reject) => {
      const timer = setTimeout(() => finish(new Error(`context ${name} timed out`)), 30_000);
      const finish = (r: ChatMessage[] | Error): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (r instanceof Error) reject(r);
        else resolveMessages(r);
      };
      this.pending.set(id, {
        onMessage: (msg) => {
          if (msg.t === "context.result") finish(msg.messages);
          else if (msg.t === "context.error") finish(new Error(msg.error.message));
        },
        onCrash: (e) => finish(new Error(e.message)),
      });
      if (!this.send({ t: "context.run", id, name, input })) finish(new Error(`plugin ${this.name} is not running`));
    });
  }

  private send(msg: ToChild): boolean {
    if (!this.child?.connected) return false;
    this.child.send(msg);
    return true;
  }

  private onMessage(msg: FromChild): void {
    if (msg.t === "log") return this.events.log(this.name, msg.level, msg.msg, msg.data);
    if (msg.t === "journal.read") {
      const events = this.events.readJournal(msg.sessionId, msg.afterSeq, msg.types);
      this.send({ t: "journal.events", id: msg.id, events });
      return;
    }
    if (msg.t === "agent.call") return this.onAgentCall(msg.id, msg.op, msg.args);
    if (msg.t === "agent.stream") return this.onAgentStream(msg.id, msg.sessionId, msg.afterSeq);
    if (msg.t === "agent.stream.close") {
      this.streams.get(msg.id)?.();
      this.streams.delete(msg.id);
      return;
    }
    if ("id" in msg) this.pending.get(msg.id)?.onMessage(msg);
  }

  private onExit(code: number | null): void {
    const crash: WireError = { code: "plugin_crashed", message: `plugin ${this.name} exited with code ${code}`, hint: "The plugin process restarts automatically; retry once." };
    for (const p of [...this.pending.values()]) p.onCrash(crash);
    this.pending.clear();
    for (const unsubscribe of this.streams.values()) unsubscribe();
    this.streams.clear();
    this.child = undefined;
    if (this.stopping || !this.autoRestart) return;

    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    this.events.crashed(this.name, code, this.crashes.length);
    if (this.crashes.length >= MAX_CRASHES) {
      this.disabled = true;
      this.events.log(this.name, "error", `disabled after ${MAX_CRASHES} crashes in 10 minutes`);
      return;
    }
    const delay = Math.min(30_000, 500 * 2 ** (this.crashes.length - 1));
    const restarting: Promise<void> = new Promise<void>((resolveRestart) => {
      setTimeout(() => {
        if (this.stopping) return resolveRestart();
        this.start()
          .catch((e: unknown) => this.events.log(this.name, "error", `restart failed: ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => {
            if (this.restarting === restarting) this.restarting = undefined;
            resolveRestart();
          });
      }, delay).unref();
    });
    this.restarting = restarting;
  }

  /** Calls made while the plugin is restarting wait for it instead of failing. */
  private async whenRunning(): Promise<void> {
    while (!this.child?.connected && this.restarting && !this.disabled) await this.restarting;
  }

  private resolveSecrets(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of this.loaded.manifest.permissions.secrets ?? []) {
      const v = this.secrets.get(name);
      if (v !== undefined) out[name] = v;
    }
    return out;
  }

  /** Provider plugins may also reach the hosts of providers configured by the human in config.yaml. */
  private netPolicy(): string[] {
    const allow = [...this.policy.net.allow];
    if (this.loaded.manifest.kinds.includes("provider")) {
      for (const p of Object.values(this.config.providers)) {
        if (p.baseUrl) allow.push(new URL(p.baseUrl).hostname);
      }
      if (Object.values(this.config.providers).some((p) => p.protocol === "anthropic" && !p.baseUrl)) allow.push("api.anthropic.com");
    }
    return allow;
  }
}

function wireOf(e: unknown): WireError {
  const code = e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : "internal";
  return { code, message: e instanceof Error ? e.message : String(e) };
}

export class ProviderError extends Error {
  constructor(readonly wire: WireError) {
    super(wire.message);
    this.name = "ProviderError";
  }
}

export class PluginHost {
  readonly plugins = new Map<string, PluginProcess>();

  constructor(
    private readonly paths: SintyPaths,
    private readonly config: SintyConfig,
    private readonly policy: SintyPolicy,
    private readonly secrets: SecretStore,
    private readonly events: HostEvents,
  ) {}

  async start(): Promise<{ failed: { plugin: string; error: string }[] }> {
    const failed: { plugin: string; error: string }[] = [];
    await Promise.all(
      this.config.plugins.enabled.map(async (name) => {
        try {
          const loaded = findPlugin(this.paths, name, this.config.plugins.searchPaths);
          const proc = new PluginProcess(loaded, this.paths, this.config, this.policy, this.secrets, this.events);
          await proc.start();
          this.plugins.set(name, proc);
        } catch (e) {
          failed.push({ plugin: name, error: e instanceof Error ? e.message : String(e) });
        }
      }),
    );
    return { failed };
  }

  stop(): void {
    for (const p of this.plugins.values()) p.stop();
  }

  /** Stops a plugin and forgets it until the next reload. Windows cannot delete the folder of a running process. */
  async unload(name: string): Promise<void> {
    const old = this.plugins.get(name);
    this.plugins.delete(name);
    if (old) await old.stopAndWait();
  }

  /** Restarts a plugin from disk (after a patch or rollback). Returns the error if the new version does not start. */
  async reload(name: string): Promise<string | undefined> {
    await this.unload(name);
    try {
      const loaded = findPlugin(this.paths, name, this.config.plugins.searchPaths);
      const proc = new PluginProcess(loaded, this.paths, this.config, this.policy, this.secrets, this.events);
      await proc.start();
      this.plugins.set(name, proc);
      return undefined;
    } catch (e) {
      this.plugins.delete(name);
      return e instanceof Error ? e.message : String(e);
    }
  }

  /** Starts a plugin from an arbitrary folder without registering it; the caller stops it. */
  async startDetached(loaded: LoadedManifest): Promise<PluginProcess> {
    const proc = new PluginProcess(loaded, this.paths, this.config, this.policy, this.secrets, { ...this.events, loaded: () => undefined, crashed: () => undefined });
    proc.autoRestart = false;
    await proc.start();
    return proc;
  }

  locate(name: string): LoadedManifest {
    return findPlugin(this.paths, name, this.config.plugins.searchPaths);
  }

  tools(): RegisteredTool[] {
    const out: RegisteredTool[] = [];
    for (const p of this.plugins.values()) {
      if (p.disabled) continue;
      for (const t of p.tools) out.push({ ...t, plugin: p.name });
    }
    return out;
  }

  toolOwner(name: string): PluginProcess | undefined {
    for (const p of this.plugins.values()) if (!p.disabled && p.tools.some((t) => t.name === name)) return p;
    return undefined;
  }

  providerFor(protocol: string): PluginProcess | undefined {
    for (const p of this.plugins.values()) if (!p.disabled && p.providers.includes(protocol)) return p;
    return undefined;
  }

  contexts(): { plugin: PluginProcess; name: string; order: number }[] {
    const out: { plugin: PluginProcess; name: string; order: number }[] = [];
    for (const p of this.plugins.values()) if (!p.disabled) for (const c of p.contexts) out.push({ plugin: p, ...c });
    return out.sort((a, b) => a.order - b.order);
  }

  broadcast(event: SintyEvent): void {
    for (const p of this.plugins.values()) p.forward(event);
  }
}

function httpHost(m: PluginManifest): string | undefined {
  if (m.runtime !== "http" || !m.url) return undefined;
  try {
    return new URL(m.url).hostname;
  } catch {
    return undefined;
  }
}

