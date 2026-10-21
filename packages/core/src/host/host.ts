import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentScope, ChatMessage, ContextInput, ContextSnapshot, EventType, LiveEvent, PluginManifest, ProviderChunk, RecoverOutcome, SintyEvent } from "@sinty/sdk";
import type { SintyConfig, SintyPolicy } from "../config.js";
import type { SintyPaths } from "../paths.js";
import type { SecretStore } from "../secrets.js";
import { CORE_TOOL_NAMES, reservedToolOwner } from "../coretools.js";
import { checkPublicUrl, NetGuardError, parseAllowPrivate, publicFetch, startGuardProxy, type GuardOptions, type GuardProxy } from "../netguard.js";
import { findPlugin, pluginDataDir, resolveFsGrants, type LoadedManifest } from "./manifest.js";
import type { AgentOp, CallCtx, FromChild, NetPublicInit, ProviderWireRequest, RouteInfo, ToChild, ToolInfo, WireError } from "./protocol.js";

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

/** `permissions.net` token for ctx.net.public (public internet through the core). */
export const PUBLIC_NET = "$PUBLIC";

/** Files Playwright checks on Linux before it starts Chromium. */
const LINUX_BROWSER_PROBES = ["/proc/sys/fs/binfmt_misc/WSLInterop", "/run/WSL", "/etc/os-release", "/usr/lib/os-release"];

/** Where Playwright keeps its browsers: PLAYWRIGHT_BROWSERS_PATH, else the per-user cache Playwright uses itself. */
export function browsersPath(): string {
  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (env && env !== "0") return resolve(env);
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "ms-playwright");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ms-playwright");
}

export interface HostEvents {
  log(plugin: string, level: string, msg: string, data?: unknown): void;
  loaded(plugin: string, version: string): void;
  crashed(plugin: string, exitCode: number | null, restarts: number): void;
  readJournal(sessionId: string, afterSeq?: number, types?: EventType[]): SintyEvent[];
  agent?: AgentBridge;
  /** ctx.models from a plugin; the core checks permissions.models, budgets and journals the call. */
  models?: (plugin: string, allowed: string[] | undefined, op: "complete" | "embed", req: Record<string, unknown>) => Promise<unknown>;
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
  embedders: string[] = [];
  memoryProviders: string[] = [];
  memoryProcessors: { name: string; order: number; hooks: string[] }[] = [];
  /** Registered ctx.onContextSnapshot (see `inspector`). */
  inspects = false;
  /** A `ui`-only plugin without an entry: the core serves its files, no process runs. */
  staticOnly = false;
  private readonly streams = new Map<number, () => void>();
  /** The browser proxy for this process (permissions.browser); closed when the process exits. */
  private proxy: Promise<GuardProxy> | undefined;

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
      if (!m.ui?.static) throw new Error(`plugin ${m.name}: a ui plugin without entry needs "ui": { "static": "<folder>" }`);
      this.staticOnly = true;
      this.events.loaded(this.name, m.version);
      return;
    }
    if (m.runtime !== "node" && m.runtime !== "mcp-stdio" && m.runtime !== "http") throw new Error(`plugin ${m.name}: runtime ${m.runtime} is not supported by this core version yet`);
    if (m.runtime === "node" && !m.entry) throw new Error(`plugin ${m.name}: entry is required`);
    if (m.permissions.browser && !(m.permissions.net ?? []).includes(PUBLIC_NET)) throw new Error(`plugin ${m.name}: permissions.browser needs "${PUBLIC_NET}" in permissions.net`);
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
          const reserved = msg.tools.filter((t) => CORE_TOOL_NAMES.has(t.name)).map((t) => t.name);
          if (reserved.length) {
            this.stopping = true;
            child.kill();
            reject(new Error(`plugin ${this.name}: tool name ${reserved.join(", ")} is reserved by the core; rename the tool (core tools cannot be replaced by plugins)`));
            return;
          }
          const taken = msg.tools.filter((t) => (reservedToolOwner(t.name) ?? this.name) !== this.name).map((t) => `${t.name} (${reservedToolOwner(t.name)})`);
          if (taken.length) {
            this.stopping = true;
            child.kill();
            reject(new Error(`plugin ${this.name}: tool name ${taken.join(", ")} is reserved for a bundled plugin; rename the tool`));
            return;
          }
          this.tools = msg.tools;
          this.providers = msg.providers;
          this.contexts = msg.contexts;
          this.subscriptions = msg.subscriptions;
          this.routes = msg.routes;
          this.embedders = msg.embedders ?? [];
          const memory = msg.memory ?? { providers: [], processors: [] };
          if ((memory.providers.length || memory.processors.length) && !m.kinds.includes("memory")) {
            this.events.log(this.name, "warn", 'registers memory providers or processors but "memory" is not in kinds; they are ignored');
            this.memoryProviders = [];
            this.memoryProcessors = [];
          } else {
            this.memoryProviders = memory.providers;
            this.memoryProcessors = memory.processors;
          }
          this.inspects = msg.inspects === true;
          if (this.inspects && !this.inspector) {
            this.events.log(
              this.name,
              "warn",
              (m.permissions.context ?? []).includes("inspect")
                ? `registers onContextSnapshot but is not in plugins.inspect; add it to config.yaml plugins.inspect to send it the prompt of every step`
                : `registers onContextSnapshot without permissions.context ["inspect"]; it gets no snapshots`,
            );
          }
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
    const grants = resolveFsGrants(this.paths, this.loaded, this.config.plugins.config[this.loaded.manifest.name] ?? {});
    for (const w of grants.write) mkdirSync(w, { recursive: true });
    return [
      "--permission",
      `--allow-fs-read=${this.paths.install}`,
      `--allow-fs-read=${this.loaded.dir}`,
      `--allow-fs-read=${join(this.paths.plugins, "node_modules")}`,
      ...grants.read.map((p) => `--allow-fs-read=${p}`),
      ...grants.write.flatMap((p) => [`--allow-fs-read=${p}`, `--allow-fs-write=${p}`]),
      ...(this.loaded.manifest.permissions.shell || this.loaded.manifest.runtime === "mcp-stdio" || this.loaded.manifest.permissions.browser ? ["--allow-child-process"] : []),
      ...(this.loaded.manifest.permissions.browser ? this.browserArgs() : []),
      "--disable-warning=ExperimentalWarning",
    ];
  }

  /** `$DATA/tmp`: the browser profile and Playwright's temp files; the process gets TMP/TEMP/TMPDIR pointing here. */
  private browserTmp(): string {
    return join(pluginDataDir(this.paths, this.name), "tmp");
  }

  /**
   * permissions.browser: read the Playwright browser install and use a temp folder of its own. Launching Chromium
   * needs --allow-child-process, which the Node permission model cannot narrow further; its network goes through
   * the core's proxy (net.public proxy). On Linux Playwright also probes a few system files (WSL markers,
   * os-release) with existsSync, which throws under the permission model unless reading them is allowed.
   */
  private browserArgs(): string[] {
    const tmp = this.browserTmp();
    mkdirSync(tmp, { recursive: true });
    return [
      `--allow-fs-read=${browsersPath()}`,
      `--allow-fs-read=${tmp}`,
      `--allow-fs-write=${tmp}`,
      ...(process.platform === "linux" ? LINUX_BROWSER_PROBES.map((p) => `--allow-fs-read=${p}`) : []),
    ];
  }

  childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const k of ["NODE_ENV", "PATH", "SYSTEMROOT", "TEMP", "TMP", ...(this.loaded.manifest.permissions.env ?? [])]) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
    if (this.loaded.manifest.permissions.browser) {
      const tmp = this.browserTmp();
      env.TMP = tmp;
      env.TEMP = tmp;
      env.TMPDIR = tmp;
      env.PLAYWRIGHT_BROWSERS_PATH = browsersPath();
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

  /**
   * May receive context snapshots: the manifest asks for permissions.context ["inspect"], the human listed the plugin
   * in config.yaml plugins.inspect, and the plugin registered a handler. Snapshots hold the whole prompt.
   */
  get inspector(): boolean {
    return this.inspects && !this.disabled && (this.loaded.manifest.permissions.context ?? []).includes("inspect") && (this.config.plugins.inspect ?? []).includes(this.name);
  }

  /** Fire and forget; no-op unless `inspector`. */
  sendSnapshot(snapshot: ContextSnapshot): void {
    if (!this.inspector) return;
    try {
      this.send({ t: "context.snapshot", snapshot });
    } catch (e) {
      this.events.log(this.name, "warn", "context snapshot was not delivered", e instanceof Error ? e.message : String(e));
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

  async embedProvider(protocol: string, req: { endpoint: ProviderWireRequest["endpoint"]; model: string; input: string[] }, signal?: AbortSignal, timeoutMs = 60_000): Promise<{ vectors: number[][]; usage?: { inputTokens: number } }> {
    const value = await this.request<{ vectors: number[][]; usage?: { inputTokens: number } }>(
      (id) => ({ t: "provider.embed", id, protocol, req }),
      (msg) => (msg.t === "provider.embedded" ? msg : undefined),
      timeoutMs,
      `embeddings via ${protocol}`,
      signal,
    );
    return value;
  }

  /** Calls a memory provider or processor method in the plugin process. */
  async callMemory(kind: "provider" | "processor", name: string, method: string, args: unknown[], timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    return this.request(
      (id) => ({ t: "memory.call", id, kind, name, method, args }),
      (msg) => (msg.t === "memory.result" ? msg : undefined),
      timeoutMs,
      `memory ${kind} ${name}.${method}`,
      signal,
    );
  }

  /** One request, one answer, with a timeout; rejects with a ProviderError carrying the wire error. */
  private async request<T>(build: (id: number) => ToChild, match: (msg: FromChild) => ({ ok: true; value: unknown } | { ok: false; error: WireError }) | undefined, timeoutMs: number, what: string, signal?: AbortSignal): Promise<T> {
    await this.whenRunning();
    const id = ++this.nextId;
    return new Promise<T>((resolveValue, reject) => {
      let done = false;
      const finish = (r: { ok: true; value: unknown } | { ok: false; error: WireError }): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        if (r.ok) resolveValue(r.value as T);
        else reject(new ProviderError(r.error));
      };
      const timer = setTimeout(() => {
        this.send({ t: "cancel", id });
        finish({ ok: false, error: { code: "timeout", message: `${what} did not answer in ${timeoutMs} ms` } });
      }, timeoutMs);
      const onAbort = (): void => {
        this.send({ t: "cancel", id });
        finish({ ok: false, error: { code: "aborted", message: "cancelled" } });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        onMessage: (msg) => {
          const r = match(msg);
          if (r) finish(r);
        },
        onCrash: (error) => finish({ ok: false, error }),
      });
      if (!this.send(build(id))) finish({ ok: false, error: { code: "plugin_unavailable", message: `plugin ${this.name} is not running` } });
    });
  }

  private onModelsCall(id: number, op: "complete" | "embed", req: Record<string, unknown>): void {
    const models = this.events.models;
    if (!models) {
      this.send({ t: "models.result", id, ok: false, error: { code: "models_unavailable", message: "this core has no model gateway" } });
      return;
    }
    models(this.name, this.loaded.manifest.permissions.models, op, req && typeof req === "object" ? req : {})
      .then((value) => this.send({ t: "models.result", id, ok: true, value }))
      .catch((e: unknown) => this.send({ t: "models.result", id, ok: false, error: wireOf(e) }));
  }

  /** What the guard allows for this plugin: config.yaml `plugins.config.<name>.allowPrivate`, never the manifest default. */
  guardOptions(): GuardOptions {
    return { allow: parseAllowPrivate(this.config.plugins.config[this.name]?.allowPrivate) };
  }

  private onNetPublic(msg: { id: number; op: "fetch"; url: string; init: NetPublicInit } | { id: number; op: "proxy" } | { id: number; op: "check"; url: string }): void {
    const reply = (p: Promise<unknown>): void => {
      p.then((value) => this.send({ t: "net.result", id: msg.id, ok: true, value: value as never })).catch((e: unknown) => {
        const error: WireError = e instanceof NetGuardError ? { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) } : wireOf(e);
        this.send({ t: "net.result", id: msg.id, ok: false, error });
      });
    };
    const perms = this.loaded.manifest.permissions;
    if (!(perms.net ?? []).includes(PUBLIC_NET)) {
      return reply(Promise.reject(new NetGuardError("net_denied", `plugin ${this.name} lacks permissions.net "${PUBLIC_NET}"`, `Add "${PUBLIC_NET}" to permissions.net in the manifest.`)));
    }
    if (msg.op === "proxy") {
      if (!perms.browser) return reply(Promise.reject(new NetGuardError("net_denied", `plugin ${this.name} lacks permissions.browser`)));
      this.proxy ??= startGuardProxy(() => this.guardOptions(), (m) => this.events.log(this.name, "info", m));
      const p = this.proxy;
      p.catch(() => {
        if (this.proxy === p) this.proxy = undefined;
      });
      return reply(p.then(({ server, username, password }) => ({ server, username, password })));
    }
    if (msg.op === "check") return reply(checkPublicUrl(String(msg.url), this.guardOptions()).then(() => ({ ok: true })));
    const init = msg.init && typeof msg.init === "object" ? msg.init : {};
    reply(
      publicFetch(String(msg.url), init, this.guardOptions()).then((r) => {
        if (r.redirects.length) this.events.log(this.name, "debug", `net.public ${msg.url} redirected`, r.redirects);
        return r;
      }),
    );
  }

  private closeProxy(): void {
    const p = this.proxy;
    this.proxy = undefined;
    p?.then((x) => x.close()).catch(() => undefined);
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
    if (msg.t === "models.call") return this.onModelsCall(msg.id, msg.op, msg.req);
    if (msg.t === "net.public") return this.onNetPublic(msg);
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
    this.closeProxy();
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
  const hint = e && typeof e === "object" && "hint" in e && typeof e.hint === "string" ? e.hint : undefined;
  return { code, message: e instanceof Error ? e.message : String(e), ...(hint ? { hint } : {}) };
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
    // Plugins start in parallel and finish in any order. Keep the map in plugins.enabled order so tools, contexts,
    // memory providers and duplicate-tool ownership do not depend on that race (the tool list is part of the cached
    // prompt prefix).
    this.reorder();
    this.warnDuplicateTools();
    return { failed };
  }

  /** Puts the plugin map back in plugins.enabled order (after a parallel start or a reload). */
  private reorder(): void {
    const all = new Map(this.plugins);
    this.plugins.clear();
    for (const name of this.config.plugins.enabled) {
      const p = all.get(name);
      if (p) this.plugins.set(name, p);
    }
    for (const [name, p] of all) if (!this.plugins.has(name)) this.plugins.set(name, p);
  }

  /** Two plugins with the same tool name: the first one wins in toolOwner(); say so loudly. */
  private warnDuplicateTools(): void {
    const owners = new Map<string, string>();
    for (const p of this.plugins.values()) {
      for (const t of p.tools) {
        const first = owners.get(t.name);
        if (first && first !== p.name) this.events.log(p.name, "warn", `tool ${t.name} is also registered by plugin ${first}; calls go to ${first}`);
        else owners.set(t.name, p.name);
      }
    }
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
      this.reorder();
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

  embedderFor(protocol: string): PluginProcess | undefined {
    for (const p of this.plugins.values()) if (!p.disabled && p.embedders.includes(protocol)) return p;
    return undefined;
  }

  /** Memory providers registered by running plugins, as `{ plugin, name }`. */
  memoryProviders(): { plugin: PluginProcess; name: string }[] {
    const out: { plugin: PluginProcess; name: string }[] = [];
    for (const p of this.plugins.values()) if (!p.disabled) for (const name of p.memoryProviders) out.push({ plugin: p, name });
    return out;
  }

  /** Memory processors of running plugins, sorted by order, then plugin name. */
  memoryProcessors(): { plugin: PluginProcess; name: string; order: number; hooks: string[] }[] {
    const out: { plugin: PluginProcess; name: string; order: number; hooks: string[] }[] = [];
    for (const p of this.plugins.values()) if (!p.disabled) for (const proc of p.memoryProcessors) out.push({ plugin: p, ...proc });
    return out.sort((a, b) => a.order - b.order || a.plugin.name.localeCompare(b.plugin.name));
  }

  contexts(): { plugin: PluginProcess; name: string; order: number }[] {
    const out: { plugin: PluginProcess; name: string; order: number }[] = [];
    for (const p of this.plugins.values()) if (!p.disabled) for (const c of p.contexts) out.push({ plugin: p, ...c });
    return out.sort((a, b) => a.order - b.order);
  }

  /** Running plugins that may receive context snapshots. Empty in the default install, so no snapshot is ever built. */
  inspectors(): PluginProcess[] {
    const out: PluginProcess[] = [];
    for (const p of this.plugins.values()) if (p.inspector) out.push(p);
    return out;
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

