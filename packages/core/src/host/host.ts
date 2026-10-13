import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatMessage, ContextInput, EventType, ProviderChunk, RecoverOutcome, SintyEvent } from "@sinty/sdk";
import type { SintyConfig, SintyPolicy } from "../config.js";
import type { SintyPaths } from "../paths.js";
import type { SecretStore } from "../secrets.js";
import { findPlugin, resolveFsGrants, type LoadedManifest } from "./manifest.js";
import type { CallCtx, FromChild, ProviderWireRequest, ToChild, ToolInfo, WireError } from "./protocol.js";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "runner.js");
const READY_TIMEOUT_MS = 15_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const CRASH_WINDOW_MS = 10 * 60_000;
const MAX_CRASHES = 5;

export type ToolOutcome = { ok: true; content: unknown } | { ok: false; error: WireError };

export interface HostEvents {
  log(plugin: string, level: string, msg: string, data?: unknown): void;
  loaded(plugin: string, version: string): void;
  crashed(plugin: string, exitCode: number | null, restarts: number): void;
  readJournal(sessionId: string, afterSeq?: number, types?: EventType[]): SintyEvent[];
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
  disabled = false;
  tools: ToolInfo[] = [];
  providers: string[] = [];
  contexts: { name: string; order: number }[] = [];
  subscriptions: (EventType | "*")[] = [];

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
    if (m.runtime !== "node") throw new Error(`plugin ${m.name}: runtime ${m.runtime} is not supported by this core version yet`);
    if (!m.entry) throw new Error(`plugin ${m.name}: entry is required`);
    const grants = resolveFsGrants(this.paths, this.loaded);
    for (const w of grants.write) mkdirSync(w, { recursive: true });

    const execArgv = [
      "--permission",
      `--allow-fs-read=${this.paths.install}`,
      `--allow-fs-read=${this.loaded.dir}`,
      ...grants.read.map((p) => `--allow-fs-read=${p}`),
      ...grants.write.flatMap((p) => [`--allow-fs-read=${p}`, `--allow-fs-write=${p}`]),
      "--disable-warning=ExperimentalWarning",
    ];
    const env: NodeJS.ProcessEnv = {};
    for (const k of ["NODE_ENV", "PATH", "SYSTEMROOT", "TEMP", "TMP", ...(m.permissions.env ?? [])]) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }

    const child = fork(RUNNER, [], { execArgv, env, cwd: this.loaded.dir, stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "advanced" });
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
      entry: resolve(this.loaded.dir, m.entry),
      config: { ...(m.config ?? {}), ...(this.config.plugins.config[m.name] ?? {}) },
      secrets: this.resolveSecrets(),
      net: { manifest: m.permissions.net ?? [], policy: this.netPolicy() },
      paths: { workspace: this.paths.workspace, skills: this.paths.skills, plugin: this.loaded.dir },
    });
    await ready;
    this.events.loaded(this.name, m.version);
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
    if ("id" in msg) this.pending.get(msg.id)?.onMessage(msg);
  }

  private onExit(code: number | null): void {
    const crash: WireError = { code: "plugin_crashed", message: `plugin ${this.name} exited with code ${code}`, hint: "The plugin process restarts automatically; retry once." };
    for (const p of [...this.pending.values()]) p.onCrash(crash);
    this.pending.clear();
    this.child = undefined;
    if (this.stopping) return;

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
