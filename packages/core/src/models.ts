import type { ChatMessage, CompleteResult, EmbedResult, ProviderEndpoint, ToolSchema } from "@sinty/sdk";
import type { SintyConfig } from "./config.js";
import type { PluginHost } from "./host/host.js";
import type { AppendInput } from "./journal.js";
import type { SecretStore } from "./secrets.js";

export class ModelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export interface GatewayDeps {
  config: SintyConfig;
  secrets: SecretStore;
  host: PluginHost;
  record?: ((input: AppendInput<"models.called" | "usage.recorded">) => void) | undefined;
  log?: ((level: string, msg: string, data?: unknown) => void) | undefined;
  /** Where plugin token usage per UTC day is kept. The core passes the journal so a restart does not reset budgets. */
  usage?: PluginUsageStore | undefined;
}

export interface PluginUsageStore {
  get(plugin: string, day: string): number;
  add(plugin: string, day: string, tokens: number): void;
}

/** In-process fallback when no store is given (unit tests, embedders). */
class MemoryUsage implements PluginUsageStore {
  private readonly spent = new Map<string, number>();
  get(plugin: string, day: string): number {
    return this.spent.get(`${plugin}|${day}`) ?? 0;
  }
  add(plugin: string, day: string, tokens: number): void {
    this.spent.set(`${plugin}|${day}`, this.get(plugin, day) + tokens);
  }
}

export interface CompleteCall {
  route?: string | undefined;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  maxOutputTokens?: number | undefined;
  reasoning?: "off" | "low" | "medium" | "high" | undefined;
  signal?: AbortSignal | undefined;
}

export interface EmbedCall {
  route?: string | undefined;
  input: string[];
  signal?: AbortSignal | undefined;
}

const DEFAULT_PLUGIN_TOKENS_PER_DAY = 2_000_000;

/**
 * Model calls that are not the main turn: compaction summaries, plugin side calls (ctx.models) and embeddings.
 * Resolves route names, injects secrets, enforces per-plugin budgets and journals plugin usage.
 */
export class ModelGateway {
  private readonly usage: PluginUsageStore;

  constructor(private readonly d: GatewayDeps) {
    this.usage = d.usage ?? new MemoryUsage();
  }

  /** "default" | "cheap" | "embed" | a models.routes key | "provider/model" → candidate routes in order. */
  resolve(route = "default"): string[] {
    const m = this.d.config.models;
    const routes = m.routes ?? {};
    let out: (string | undefined)[];
    if (route === "default") out = [m.default, ...m.fallback];
    else if (route === "cheap") out = [routes.cheap || this.d.config.service.model || m.default];
    else if (route === "embed") out = [routes.embed];
    else if (routes[route]) out = [routes[route]];
    else if (route.includes("/")) out = [route];
    else out = [];
    return out.filter((r): r is string => Boolean(r && r.trim()));
  }

  hasRoute(route: string): boolean {
    return this.resolve(route).length > 0;
  }

  async complete(call: CompleteCall): Promise<CompleteResult> {
    const candidates = this.resolve(call.route);
    if (!candidates.length) throw new ModelError("route_missing", `no model for route ${call.route ?? "default"}`, "Set models.default or models.routes in config.yaml.");
    let last: unknown;
    for (const route of candidates) {
      try {
        return await this.completeOne(route, call);
      } catch (e) {
        if (call.signal?.aborted) throw e;
        last = e;
      }
    }
    throw last instanceof Error ? last : new ModelError("provider_error", String(last));
  }

  async embed(call: EmbedCall): Promise<EmbedResult> {
    const [route] = this.resolve(call.route ?? "embed");
    if (!route) throw new ModelError("route_missing", `no model for route ${call.route ?? "embed"}`, "Set models.routes.embed in config.yaml, e.g. openai/text-embedding-3-small.");
    const { providerId, model, protocol, endpoint } = this.endpoint(route);
    const plugin = this.d.host.embedderFor(protocol);
    if (!plugin) throw new ModelError("embed_unsupported", `no plugin implements embeddings for protocol ${protocol}`);
    const r = await plugin.embedProvider(protocol, { endpoint, model, input: call.input }, call.signal);
    return { vectors: r.vectors, provider: providerId, model, ...(r.usage ? { usage: r.usage } : {}) };
  }

  /** ctx.models from a plugin: permission check, budget, call, journal. */
  async pluginCall(plugin: string, allowed: string[] | undefined, op: "complete" | "embed", req: Record<string, unknown>): Promise<CompleteResult | EmbedResult> {
    const route = typeof req.route === "string" && req.route ? req.route : op === "embed" ? "embed" : "default";
    const grants = allowed ?? [];
    if (!grants.includes("*") && !grants.includes(route)) {
      throw new ModelError("models_denied", `plugin ${plugin} may not use model route ${route}`, `Add "${route}" to permissions.models in the plugin manifest.`);
    }
    const limit = this.d.config.models.pluginTokensPerDay ?? DEFAULT_PLUGIN_TOKENS_PER_DAY;
    const day = new Date().toISOString().slice(0, 10);
    const tokens = this.usage.get(plugin, day);
    if (limit > 0 && tokens >= limit) throw new ModelError("models_budget", `plugin ${plugin} used ${tokens} model tokens today (limit ${limit})`, "Raise models.pluginTokensPerDay or wait until tomorrow (UTC).");
    const sessionId = typeof req.sessionId === "string" ? req.sessionId : undefined;
    const t0 = Date.now();
    try {
      let result: CompleteResult | EmbedResult;
      let inputTokens = 0;
      let outputTokens = 0;
      if (op === "complete") {
        const messages = Array.isArray(req.messages) ? (req.messages as ChatMessage[]) : [];
        const requested = typeof req.maxOutputTokens === "number" && req.maxOutputTokens > 0 ? Math.min(req.maxOutputTokens, this.d.config.models.maxOutputTokens) : undefined;
        const reasoning = req.reasoning === "off" || req.reasoning === "low" || req.reasoning === "medium" || req.reasoning === "high" ? req.reasoning : undefined;
        const r = await this.complete({ route, messages, ...(requested ? { maxOutputTokens: requested } : {}), ...(reasoning ? { reasoning } : {}) });
        inputTokens = r.usage.inputTokens;
        outputTokens = r.usage.outputTokens;
        result = r;
      } else {
        const input = Array.isArray(req.input) ? (req.input as unknown[]).map(String) : [];
        const r = await this.embed({ route, input });
        inputTokens = r.usage?.inputTokens ?? Math.ceil(input.join(" ").length / 4);
        result = r;
      }
      this.usage.add(plugin, day, inputTokens + outputTokens);
      this.journal(sessionId, { plugin, op, route, provider: result.provider, model: result.model, inputTokens, outputTokens, ms: Date.now() - t0, ok: true });
      if (sessionId) this.d.record?.({ sessionId, type: "usage.recorded", actor: { kind: "plugin", id: plugin }, data: { provider: result.provider, model: result.model, inputTokens, outputTokens } });
      return result;
    } catch (e) {
      this.journal(sessionId, { plugin, op, route, provider: "", model: "", inputTokens: 0, outputTokens: 0, ms: Date.now() - t0, ok: false, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  private journal(sessionId: string | undefined, data: AppendInput<"models.called">["data"]): void {
    if (sessionId) this.d.record?.({ sessionId, type: "models.called", actor: { kind: "plugin", id: data.plugin }, data });
    else this.d.log?.(data.ok ? "info" : "warn", `models.${data.op} by ${data.plugin} via ${data.route}: ${data.ok ? `${data.inputTokens}+${data.outputTokens} tokens` : data.error}`);
  }

  private async completeOne(route: string, call: CompleteCall): Promise<CompleteResult> {
    const { providerId, model, protocol, endpoint } = this.endpoint(route);
    const plugin = this.d.host.providerFor(protocol);
    if (!plugin) throw new ModelError("provider_missing", `route ${route}: no plugin for protocol ${protocol}`);
    let text = "";
    let usage = { inputTokens: 0, outputTokens: 0 };
    const signal = call.signal ?? new AbortController().signal;
    const req = {
      endpoint,
      model,
      messages: call.messages,
      tools: call.tools ?? [],
      ...(call.maxOutputTokens ? { maxOutputTokens: call.maxOutputTokens } : {}),
      ...(call.reasoning ? { reasoning: call.reasoning } : {}),
    };
    for await (const chunk of plugin.streamProvider(protocol, req, signal)) {
      if (chunk.type === "text") text += chunk.text;
      else if (chunk.type === "done") usage = { inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens };
    }
    return { text, provider: providerId, model, usage };
  }

  private endpoint(route: string): { providerId: string; model: string; protocol: string; endpoint: ProviderEndpoint } {
    const slash = route.indexOf("/");
    const providerId = slash > 0 ? route.slice(0, slash) : route;
    const model = slash > 0 ? route.slice(slash + 1) : "";
    const prov = this.d.config.providers[providerId];
    if (!prov || !model) throw new ModelError("provider_missing", `route ${route}: ${!prov ? "provider not in config" : "no model id"}`);
    const apiKey = this.d.secrets.resolve(prov.apiKey);
    if (prov.apiKey && !apiKey) throw new ModelError("secret_missing", `${prov.apiKey} is not set`, `sinty secret set ${prov.apiKey.replace("secret://", "")}`);
    const endpoint: ProviderEndpoint = {};
    if (prov.baseUrl !== undefined) endpoint.baseUrl = prov.baseUrl;
    if (apiKey !== undefined) endpoint.apiKey = apiKey;
    if (prov.headers !== undefined) endpoint.headers = prov.headers;
    if (prov.options !== undefined) endpoint.options = prov.options;
    return { providerId, model, protocol: prov.protocol, endpoint };
  }
}
