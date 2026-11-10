import { isDeepStrictEqual } from "node:util";
import { definePlugin, parseSSE, ToolError, ProviderStreamError, StreamDiagnostics, parseProviderJSON, parseToolArguments, validateProviderCalls, type ProviderToolCall, type ChatMessage, type ProviderChunk, type ProviderRequest, openAIModelList } from "@sinty/sdk";

type Usage = Extract<ProviderChunk, { type: "done" }>["usage"];

export default definePlugin({
  name: "provider-openai-responses",
  setup(ctx) {
    ctx.provider({
      protocol: "openai-responses",
      async *stream(req) {
        req.signal.throwIfAborted();
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
        const complete = new Map<number, ProviderToolCall>();
        const itemIds = new Map<string, number>();
        const identities = new Map<number, { id: string; type: string; callId?: string; name?: string }>();
        const added = new Set<number>(), ended = new Set<number>();
        const diag = new StreamDiagnostics(req.endpoint.options?.streamDiagnostics === true);
        const claim = (index: number | undefined, id: string | undefined, type: string, callId?: string, name?: string): number => {
          if (!Number.isSafeInteger(index) || index! < 0 || index! > 127) throw diag.error("conflicting_output_index");
          if (typeof id !== "string" || !id || id.length > 256) throw diag.error("invalid_output_item_id");
          if (itemIds.has(id) && itemIds.get(id) !== index) throw diag.error("duplicate_output_item");
          const previous = identities.get(index!);
          if (previous && (previous.id !== id || previous.type !== type || (previous.callId !== undefined && callId !== undefined && previous.callId !== callId) || (previous.name !== undefined && name !== undefined && previous.name !== name))) throw diag.error("conflicting_output_identity");
          identities.set(index!, { id, type, ...(previous?.callId !== undefined ? { callId: previous.callId } : callId !== undefined ? { callId } : {}), ...(previous?.name !== undefined ? { name: previous.name } : name !== undefined ? { name } : {}) });
          itemIds.set(id, index!);
          return index!;
        };
        let terminal = false;
        let stopReason = "stop";
        try {
          req.signal.throwIfAborted();
          for await (const msg of parseSSE(res.body, req.signal)) {
            req.signal.throwIfAborted(); diag.frame();
            if (!msg.data || msg.data === "[DONE]") continue;
            const ev = parseProviderJSON(msg.data) as ResponsesEvent;
            if (!ev || typeof ev.type !== "string") throw diag.error("invalid_frame");
            if (terminal) throw diag.error("data_after_terminal");
            switch (ev.type) {
              case "response.output_text.delta":
                if (ev.delta) yield { type: "text", text: ev.delta }; break;
              case "response.reasoning_summary_text.delta":
              case "response.reasoning_text.delta":
                if (ev.delta) yield { type: "reasoning", text: ev.delta }; break;
              case "response.output_item.added": {
                if (!ev.item || typeof ev.item.type !== "string") throw diag.error("invalid_output_item");
                const index = claim(ev.output_index, ev.item.id, ev.item.type, ev.item.call_id, ev.item.name);
                if (added.has(index) || ended.has(index)) throw diag.error("duplicate_output_item");
                added.add(index); break;
              }
              case "response.function_call_arguments.delta":
              case "response.function_call_arguments.done":
                // These are progress, not the final full snapshot. Check correlation but never append snapshots.
                if (ended.has(claim(ev.output_index, ev.item_id, "function_call"))) throw diag.error("data_after_output_done");
                break;
              case "response.output_item.done": {
                if (!ev.item || typeof ev.item.type !== "string") throw diag.error("invalid_output_item");
                const index = claim(ev.output_index, ev.item.id, ev.item.type, ev.item.call_id, ev.item.name);
                if (ended.has(index)) throw diag.error("duplicate_output_item");
                ended.add(index);
                if (ev.item.type === "function_call") {
                  if (ev.item.status !== undefined && ev.item.status !== "completed") throw diag.error("incomplete_tool_calls");
                  const raw = ev.item.arguments ?? "";
                  diag.call(index, ev.item.call_id ?? "", ev.item.name ?? "", raw);
                  complete.set(index, { id: ev.item.call_id ?? "", name: ev.item.name ?? "", args: parseToolArguments(raw) });
                }
                break;
              }
              case "response.completed":
                if (ev.response?.status !== undefined && ev.response.status !== "completed") throw diag.error("incomplete_response");
                if (ev.response?.output !== undefined && !Array.isArray(ev.response.output)) throw diag.error("conflicting_response_snapshot");
                if (ev.response?.output) {
                  const snapshots = ev.response.output.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.type === "function_call");
                  if (snapshots.length !== complete.size) throw diag.error("conflicting_response_snapshot");
                  for (const { entry, index } of snapshots) {
                    const call = complete.get(index);
                    if ((entry.status !== undefined && entry.status !== "completed") || !call || identities.get(index)?.id !== entry.id || call.id !== entry.call_id || call.name !== entry.name || !isDeepStrictEqual(call.args, parseToolArguments(entry.arguments ?? ""))) throw diag.error("conflicting_response_snapshot");
                  }
                }
                usage = usageOf(ev.response?.usage); terminal = true; diag.end(); break;
              case "response.incomplete":
                if (complete.size || ev.response?.output?.some((entry) => entry.type === "function_call")) throw diag.error("incomplete_tool_calls");
                stopReason = ev.response?.incomplete_details?.reason === "max_output_tokens" ? "length" : "incomplete";
                usage = usageOf(ev.response?.usage); terminal = true; diag.end(); break;
              case "response.failed": throw new ToolError("provider_error", "upstream_stream_error", { retryable: ev.response?.error?.code === "server_error" });
              case "error": throw new ToolError("provider_error", "upstream_stream_error", { retryable: ev.code === "server_error" || ev.code === "rate_limit_exceeded" });
            }
          }
          req.signal.throwIfAborted();
          if (!terminal) throw diag.error("missing_terminal");
          if ([...identities.entries()].some(([index, item]) => item.type === "function_call" && !complete.has(index))) throw diag.error("incomplete_tool_calls");
          const calls = [...complete.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
          validateProviderCalls(calls, req.tools);
          for (const call of calls) yield { type: "tool_call", ...call };
          yield { type: "done", stopReason: calls.length ? "tool_calls" : stopReason, usage };
        } catch (e) {
          if (e instanceof ProviderStreamError) throw diag.error(e.message.replace("Invalid provider stream: ", ""));
          throw e;
        }
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
  const { promptCacheKey, streamDiagnostics: _diagnostics, toolCallNameMode: _nameMode, ...options } = req.endpoint.options ?? {};
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
  output_index?: number;
  item_id?: string;
  message?: string;
  code?: string;
  item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string; status?: string };
  response?: {
    status?: string;
    output?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string; status?: string }[];
    usage?: ResponsesUsage;
    incomplete_details?: { reason?: string } | null;
    error?: { code?: string; message?: string } | null;
  };
}
