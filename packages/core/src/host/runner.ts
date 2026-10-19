import { pathToFileURL } from "node:url";
import {
  ToolError,
  z,
  type AgentApi,
  type ChatMessage,
  type ContextContributor,
  type EventType,
  type HttpRoute,
  type LiveEvent,
  type PluginContext,
  type PluginDefinition,
  type ProviderDefinition,
  type SintyEvent,
  type ToolDefinition,
} from "@sinty/sdk";
import { hostAllowed } from "../policy.js";
import { connectMcp } from "./mcp-stdio.js";
import { connectMcpHttp } from "./mcp-http.js";
import type { AgentOp, FromChild, InitMessage, ToChild, ToolInfo, WireError, WireHttpRequest } from "./protocol.js";

const send = (msg: FromChild): void => {
  process.send?.(msg);
};

const tools = new Map<string, ToolDefinition>();
const providers = new Map<string, ProviderDefinition>();
const contexts = new Map<string, { fn: ContextContributor; order: number }>();
const listeners = new Map<string, ((e: SintyEvent) => void | Promise<void>)[]>();
const running = new Map<number, AbortController>();
const journalWaiters = new Map<number, (events: SintyEvent[]) => void>();
let journalSeq = 0;
const routes: HttpRoute[] = [];
const agentWaiters = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
const agentStreams = new Map<number, { push(e: LiveEvent): void; end(error?: WireError): void }>();
let agentSeq = 0;
let closeMcp: (() => void) | undefined;

function agentCall<T>(op: AgentOp, ...args: unknown[]): Promise<T> {
  const id = ++agentSeq;
  return new Promise<T>((resolve, reject) => {
    agentWaiters.set(id, { resolve: resolve as (v: unknown) => void, reject });
    send({ t: "agent.call", id, op, args });
  });
}

const agentApi: AgentApi = {
  listSessions: (opts) => agentCall("listSessions", opts ?? {}),
  getSession: (id) => agentCall("getSession", id),
  events: (sessionId, opts) => agentCall("events", sessionId, opts ?? {}),
  createSession: (init) => agentCall("createSession", init ?? {}),
  send: (sessionId, text, opts) => agentCall("send", sessionId, text, opts ?? {}),
  interrupt: (sessionId) => agentCall("interrupt", sessionId),
  stream(sessionId, opts) {
    return (async function* () {
      const id = ++agentSeq;
      const queue: LiveEvent[] = [];
      let ended: { error?: WireError } | undefined;
      let wake: (() => void) | undefined;
      agentStreams.set(id, {
        push(e) {
          queue.push(e);
          wake?.();
        },
        end(error) {
          ended = error ? { error } : {};
          wake?.();
        },
      });
      const onAbort = (): void => {
        ended ??= {};
        wake?.();
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      send({ t: "agent.stream", id, sessionId, afterSeq: opts?.afterSeq ?? 0 });
      try {
        for (;;) {
          if (queue.length) {
            yield queue.shift()!;
            continue;
          }
          if (ended) {
            if (ended.error) throw new ToolError(ended.error.code, ended.error.message);
            return;
          }
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
        }
      } finally {
        opts?.signal?.removeEventListener("abort", onAbort);
        agentStreams.delete(id);
        send({ t: "agent.stream.close", id });
      }
    })();
  },
};

async function serveHttp(id: number, r: WireHttpRequest): Promise<void> {
  const route = routes[r.route];
  if (!route) return send({ t: "http.error", id, error: { code: "not_found", message: "no such route" } });
  const ac = new AbortController();
  running.set(id, ac);
  try {
    const hasBody = r.body && r.method !== "GET" && r.method !== "HEAD";
    const req = new Request(new URL(r.url, "http://plugin.local"), { method: r.method, headers: r.headers, ...(hasBody ? { body: r.body } : {}), signal: ac.signal });
    const res = await route.handler(req, { params: r.params, signal: ac.signal });
    send({ t: "http.start", id, status: res.status, headers: [...res.headers.entries()] });
    if (res.body) {
      const reader = res.body.getReader();
      ac.signal.addEventListener("abort", () => void reader.cancel().catch(() => undefined), { once: true });
      for (;;) {
        const { done, value } = await reader.read();
        if (done || ac.signal.aborted) break;
        send({ t: "http.chunk", id, chunk: value });
      }
    }
    send({ t: "http.end", id });
  } catch (e) {
    send({ t: "http.error", id, error: toWire(e) });
  } finally {
    running.delete(id);
  }
}

function toWire(e: unknown): WireError {
  if (e instanceof ToolError) return { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}), retryable: e.retryable };
  if (e instanceof Error && e.name === "AbortError") return { code: "aborted", message: "cancelled" };
  return { code: "plugin_error", message: e instanceof Error ? e.message : String(e) };
}

function guardFetch(net: InitMessage["net"]): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const original = globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (!hostAllowed(url.hostname, net.manifest) || !hostAllowed(url.hostname, net.policy)) {
      throw new ToolError("net_denied", `host ${url.hostname} is not allowed for this plugin`, {
        hint: "Add the host to the plugin manifest permissions.net and to policy.yaml net.allow.",
      });
    }
    return original(input, init);
  };
}

async function init(msg: InitMessage): Promise<void> {
  const guarded = guardFetch(msg.net);
  globalThis.fetch = guarded as typeof fetch;

  const log =
    (level: "debug" | "info" | "warn" | "error") =>
    (m: string, data?: unknown): void =>
      send({ t: "log", level, msg: m, ...(data === undefined ? {} : { data }) });

  const ctx: PluginContext = {
    name: msg.manifest.name,
    config: Object.freeze({ ...msg.config }),
    paths: Object.freeze({ ...msg.paths }),
    log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    net: { fetch: guarded },
    secrets: {
      async get(name) {
        const v = msg.secrets[name];
        if (v === undefined) throw new ToolError("secret_missing", `secret ${name} is not available`, { hint: `Run: sinty secret set ${name}` });
        return v;
      },
    },
    journal: {
      read(sessionId, opts) {
        return (async function* () {
          const id = ++journalSeq;
          const events = await new Promise<SintyEvent[]>((resolve) => {
            journalWaiters.set(id, resolve);
            send({ t: "journal.read", id, sessionId, ...(opts?.afterSeq !== undefined ? { afterSeq: opts.afterSeq } : {}), ...(opts?.types ? { types: opts.types } : {}) });
          });
          yield* events;
        })();
      },
    },
    agent: agentApi,
    tool(def) {
      tools.set(def.name, def as unknown as ToolDefinition);
    },
    provider(def) {
      providers.set(def.protocol, def);
    },
    context(name, fn, opts) {
      contexts.set(name, { fn, order: opts?.order ?? 100 });
    },
    channel() {
      log("warn")("channels are not supported by this core version yet");
    },
    schedule() {
      log("warn")("schedules are not supported by this core version yet");
    },
    http(route) {
      routes.push(route);
    },
    on(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler as (e: SintyEvent) => void);
      listeners.set(type, list);
    },
  };

  if (msg.manifest.runtime === "mcp-stdio") {
    closeMcp = await connectMcp(msg, (def) => tools.set(def.name, def as unknown as ToolDefinition));
  } else if (msg.manifest.runtime === "http") {
    closeMcp = await connectMcpHttp(msg, (def) => tools.set(def.name, def as unknown as ToolDefinition));
  } else {
    const mod = (await import(pathToFileURL(msg.entry).href)) as { default?: PluginDefinition };
    if (!mod.default?.setup) throw new Error(`${msg.entry} has no default export from definePlugin()`);
    await mod.default.setup(ctx);
  }

  const declared = new Map((msg.manifest.tools ?? []).map((t) => [t.name, t]));
  const toolInfos: ToolInfo[] = [...tools.values()].map((t) => {
    const m = declared.get(t.name);
    return {
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.input as z.ZodType, { io: "input", unrepresentable: "any" }) as Record<string, unknown>,
      sideEffects: m?.sideEffects ?? t.sideEffects,
      idempotent: m?.idempotent ?? t.idempotent ?? false,
      recoverable: typeof t.recover === "function",
      ...(t.timeoutMs ? { timeoutMs: t.timeoutMs } : {}),
      ...((m?.docs ?? t.docs) ? { docs: (m?.docs ?? t.docs)! } : {}),
    };
  });

  send({
    t: "ready",
    tools: toolInfos,
    providers: [...providers.keys()],
    contexts: [...contexts.entries()].map(([name, c]) => ({ name, order: c.order })),
    subscriptions: [...listeners.keys()] as (EventType | "*")[],
    routes: routes.map((r) => ({ method: r.method.toUpperCase(), path: r.path, public: r.public === true })),
  });
}

async function runTool(id: number, name: string, args: unknown, c: { sessionId: string; turnId: string; callId: string; idempotencyKey: string }): Promise<void> {
  const tool = tools.get(name);
  if (!tool) return send({ t: "tool.result", id, ok: false, error: { code: "unknown_tool", message: `no tool ${name}` } });
  const parsed = (tool.input as z.ZodType).safeParse(args);
  if (!parsed.success) {
    return send({
      t: "tool.result",
      id,
      ok: false,
      error: { code: "invalid_args", message: z.prettifyError(parsed.error), hint: "Fix the arguments to match the tool input schema." },
    });
  }
  const ac = new AbortController();
  running.set(id, ac);
  try {
    const result = await tool.run(parsed.data, {
      ...c,
      signal: ac.signal,
      progress: (u) => send({ t: "tool.progress", id, ...u }),
    });
    send({ t: "tool.result", id, ok: true, content: result.content });
  } catch (e) {
    send({ t: "tool.result", id, ok: false, error: toWire(e) });
  } finally {
    running.delete(id);
  }
}

async function streamProvider(id: number, protocol: string, req: Omit<Parameters<ProviderDefinition["stream"]>[0], "signal">): Promise<void> {
  const p = providers.get(protocol);
  if (!p) return send({ t: "provider.error", id, error: { code: "unknown_protocol", message: protocol } });
  const ac = new AbortController();
  running.set(id, ac);
  try {
    for await (const chunk of p.stream({ ...req, signal: ac.signal })) send({ t: "provider.chunk", id, chunk });
    send({ t: "provider.end", id });
  } catch (e) {
    send({ t: "provider.error", id, error: toWire(e) });
  } finally {
    running.delete(id);
  }
}

process.on("message", (raw: ToChild) => {
  switch (raw.t) {
    case "init":
      init(raw).catch((e: unknown) => {
        send({ t: "fatal", error: toWire(e) });
        setTimeout(() => process.exit(1), 50);
      });
      break;
    case "tool.run":
      void runTool(raw.id, raw.name, raw.args, raw.ctx);
      break;
    case "tool.recover": {
      const tool = tools.get(raw.name);
      if (!tool?.recover) {
        send({ t: "tool.recovered", id: raw.id, outcome: { status: "unknown" } });
        break;
      }
      tool
        .recover(raw.ctx.idempotencyKey, { ...raw.ctx, signal: new AbortController().signal })
        .then((outcome) => send({ t: "tool.recovered", id: raw.id, outcome }))
        .catch(() => send({ t: "tool.recovered", id: raw.id, outcome: { status: "unknown" } }));
      break;
    }
    case "provider.stream":
      void streamProvider(raw.id, raw.protocol, raw.req);
      break;
    case "context.run": {
      const c = contexts.get(raw.name);
      if (!c) {
        send({ t: "context.result", id: raw.id, messages: raw.input.messages });
        break;
      }
      c.fn(raw.input)
        .then((messages: ChatMessage[]) => send({ t: "context.result", id: raw.id, messages }))
        .catch((e: unknown) => send({ t: "context.error", id: raw.id, error: toWire(e) }));
      break;
    }
    case "cancel":
      running.get(raw.id)?.abort();
      break;
    case "event":
      for (const h of [...(listeners.get(raw.event.type) ?? []), ...(listeners.get("*") ?? [])]) {
        Promise.resolve(h(raw.event)).catch(() => undefined);
      }
      break;
    case "journal.events":
      journalWaiters.get(raw.id)?.(raw.events);
      journalWaiters.delete(raw.id);
      break;
    case "http.request":
      void serveHttp(raw.id, raw);
      break;
    case "agent.result": {
      const w = agentWaiters.get(raw.id);
      agentWaiters.delete(raw.id);
      if (raw.ok) w?.resolve(raw.value);
      else w?.reject(new ToolError(raw.error.code, raw.error.message, raw.error.hint ? { hint: raw.error.hint } : {}));
      break;
    }
    case "agent.event":
      agentStreams.get(raw.id)?.push(raw.event);
      break;
    case "agent.end":
      agentStreams.get(raw.id)?.end(raw.error);
      break;
    case "shutdown":
      closeMcp?.();
      process.exit(0);
  }
});
