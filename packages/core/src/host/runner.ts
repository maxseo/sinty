import { pathToFileURL } from "node:url";
import {
  ToolError,
  z,
  type ChatMessage,
  type ContextContributor,
  type EventType,
  type PluginContext,
  type PluginDefinition,
  type ProviderDefinition,
  type SintyEvent,
  type ToolDefinition,
} from "@sinty/sdk";
import { hostAllowed } from "../policy.js";
import type { FromChild, InitMessage, ToChild, ToolInfo, WireError } from "./protocol.js";

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
    http() {
      log("warn")("http routes are not supported by this core version yet");
    },
    on(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler as (e: SintyEvent) => void);
      listeners.set(type, list);
    },
  };

  const mod = (await import(pathToFileURL(msg.entry).href)) as { default?: PluginDefinition };
  if (!mod.default?.setup) throw new Error(`${msg.entry} has no default export from definePlugin()`);
  await mod.default.setup(ctx);

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
    case "shutdown":
      process.exit(0);
  }
});
