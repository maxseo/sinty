import { definePlugin, parseSSE, ToolError, type ChatMessage, type ProviderChunk, type ProviderRequest, openAIModelList } from "@sinty/sdk";

type Usage = Extract<ProviderChunk, { type: "done" }>["usage"];

export default definePlugin({
  name: "provider-openai-responses",
  setup(ctx) {
    ctx.provider({
      protocol: "openai-responses",
      async *stream(req) {
        const baseUrl = (req.endpoint.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
        const res = await ctx.net.fetch(`${baseUrl}/responses`, {
          method: "POST",
          signal: req.signal,
          headers: {
            "content-type": "application/json",
            ...(req.endpoint.apiKey ? { authorization: `Bearer ${req.endpoint.apiKey}` } : {}),
            ...req.endpoint.headers,
          },
          body: JSON.stringify(buildBody(req)),
        });
        if (!res.ok || !res.body) throw await httpError(res);

        let usage: Usage = { inputTokens: 0, outputTokens: 0 };
        let stopReason = "stop";
        let sawCall = false;

        for await (const msg of parseSSE(res.body, req.signal)) {
          if (!msg.data || msg.data === "[DONE]") continue;
          const ev = JSON.parse(msg.data) as ResponsesEvent;
          switch (ev.type) {
            case "response.output_text.delta":
              if (ev.delta) yield { type: "text", text: ev.delta };
              break;
            case "response.reasoning_summary_text.delta":
            case "response.reasoning_text.delta":
              if (ev.delta) yield { type: "reasoning", text: ev.delta };
              break;
            case "response.output_item.done":
              if (ev.item?.type === "function_call") {
                sawCall = true;
                yield { type: "tool_call", id: ev.item.call_id ?? ev.item.id ?? "", name: ev.item.name ?? "", args: parseArgs(ev.item.arguments ?? "") };
              }
              break;
            case "response.completed":
            case "response.incomplete":
              usage = usageOf(ev.response?.usage);
              stopReason = ev.type === "response.incomplete" ? (ev.response?.incomplete_details?.reason === "max_output_tokens" ? "length" : (ev.response?.incomplete_details?.reason ?? "incomplete")) : sawCall ? "tool_calls" : "stop";
              break;
            case "response.failed":
              throw new ToolError("provider_error", ev.response?.error?.message ?? "response failed", { retryable: ev.response?.error?.code === "server_error" });
            case "error":
              throw new ToolError("provider_error", ev.message ?? "stream error", { retryable: ev.code === "server_error" || ev.code === "rate_limit_exceeded" });
          }
        }
        yield { type: "done", stopReason, usage };
      },
      async listModels(endpoint) {
        const baseUrl = (endpoint.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
        const res = await ctx.net.fetch(`${baseUrl}/models`, { headers: { ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}), ...endpoint.headers } });
        if (!res.ok) throw await httpError(res);
        return openAIModelList(await res.json());
      },
    });
  },
});

/**
 * Only the leading system messages (system prompt, skills, session memory) become `instructions`; a system message
 * later in the list stays in place as a `developer` item, so a context plugin's tail note does not rewrite the cached
 * instructions. `prompt_cache_key` is the core's per-session `cacheKey` unless `options.promptCacheKey` is false.
 */
export function buildBody(req: ProviderRequest): Record<string, unknown> {
  const { promptCacheKey, ...options } = req.endpoint.options ?? {};
  const lead = req.messages.findIndex((m) => m.role !== "system");
  const head = lead < 0 ? req.messages : req.messages.slice(0, lead);
  const rest = lead < 0 ? [] : req.messages.slice(lead);
  const instructions = head.map((m) => m.content).join("\n\n");
  const body: Record<string, unknown> = {
    model: req.model,
    stream: true,
    store: false,
    input: rest.flatMap(toInputItems),
    ...(instructions ? { instructions } : {}),
    ...(promptCacheKey !== false && req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
    ...options,
  };
  if (req.maxOutputTokens) body.max_output_tokens = req.maxOutputTokens;
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
  }
  if (req.reasoning && req.reasoning !== "off") body.reasoning = { effort: req.reasoning, summary: "auto" };
  return body;
}

function toInputItems(m: ChatMessage): Record<string, unknown>[] {
  if (m.role === "tool") return [{ type: "function_call_output", call_id: m.toolCallId, output: m.content }];
  if (m.role === "assistant") {
    const items: Record<string, unknown>[] = [];
    if (m.content) items.push({ role: "assistant", content: m.content });
    for (const c of m.toolCalls ?? []) items.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) });
    return items;
  }
  return [{ role: m.role === "system" ? "developer" : m.role, content: m.content }];
}

export function usageOf(u: ResponsesUsage | undefined): Usage {
  const input = u?.input_tokens ?? 0;
  const hit = u?.input_tokens_details?.cached_tokens;
  const write = u?.input_tokens_details?.cache_write_tokens;
  return {
    inputTokens: input,
    outputTokens: u?.output_tokens ?? 0,
    ...(hit ? { cachedTokens: hit } : {}),
    ...(hit !== undefined ? { cacheMissTokens: Math.max(0, input - hit) } : {}),
    ...(write ? { cacheWriteTokens: write } : {}),
  };
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __invalid_json: raw };
  }
}

async function httpError(res: Response): Promise<ToolError> {
  const text = await res.text().catch(() => "");
  const retryable = res.status === 429 || res.status >= 500;
  return new ToolError(`http_${res.status}`, text.slice(0, 1000) || res.statusText, {
    retryable,
    ...(res.status === 401 ? { hint: "Check the provider API key: sinty secret set <name>" } : {}),
  });
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

interface ResponsesEvent {
  type: string;
  delta?: string;
  message?: string;
  code?: string;
  item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
  response?: {
    usage?: ResponsesUsage;
    incomplete_details?: { reason?: string } | null;
    error?: { code?: string; message?: string } | null;
  };
}
