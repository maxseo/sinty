import { definePlugin, parseSSE, ToolError, type ChatMessage, type ProviderChunk, type ProviderRequest, openAIModelList } from "@sinty/sdk";

interface ToolCallAcc {
  id: string;
  name: string;
  args: string;
}

export default definePlugin({
  name: "provider-openai-compat",
  setup(ctx) {
    ctx.provider({
      protocol: "openai-compat",
      async *stream(req) {
        const baseUrl = (req.endpoint.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
        const res = await ctx.net.fetch(`${baseUrl}/chat/completions`, {
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

        const calls = new Map<number, ToolCallAcc>();
        let finish = "stop";
        let usage = { inputTokens: 0, outputTokens: 0 } as Extract<ProviderChunk, { type: "done" }>["usage"];

        for await (const msg of parseSSE(res.body, req.signal)) {
          if (msg.data === "[DONE]") break;
          const chunk = JSON.parse(msg.data) as ChatChunk;
          if (chunk.error) throw new ToolError("provider_error", chunk.error.message ?? "stream error");
          if (chunk.usage) usage = usageOf(chunk.usage);
          for (const choice of chunk.choices ?? []) {
            const d = choice.delta ?? {};
            const reasoning = d.reasoning_content ?? d.reasoning;
            if (reasoning) yield { type: "reasoning", text: reasoning };
            if (d.content) yield { type: "text", text: d.content };
            for (const tc of d.tool_calls ?? []) {
              const acc = calls.get(tc.index) ?? { id: "", name: "", args: "" };
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
              calls.set(tc.index, acc);
            }
            if (choice.finish_reason) finish = choice.finish_reason;
          }
        }

        for (const acc of [...calls.entries()].sort(([a], [b]) => a - b).map(([, v]) => v)) {
          yield { type: "tool_call", id: acc.id, name: acc.name, args: parseArgs(acc.args) };
        }
        yield { type: "done", stopReason: finish, usage };
      },
      async listModels(endpoint) {
        const baseUrl = (endpoint.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
        const res = await ctx.net.fetch(`${baseUrl}/models`, { headers: { ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}), ...endpoint.headers } });
        if (!res.ok) throw await httpError(res);
        return openAIModelList(await res.json());
      },
      /** POST {baseUrl}/embeddings (OpenAI-compatible). Vectors are returned in input order. */
      async embed(req) {
        const baseUrl = (req.endpoint.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
        const res = await ctx.net.fetch(`${baseUrl}/embeddings`, {
          method: "POST",
          signal: req.signal,
          headers: {
            "content-type": "application/json",
            ...(req.endpoint.apiKey ? { authorization: `Bearer ${req.endpoint.apiKey}` } : {}),
            ...req.endpoint.headers,
          },
          body: JSON.stringify({ model: req.model, input: req.input }),
        });
        if (!res.ok) throw await httpError(res);
        const body = (await res.json()) as { data?: { index?: number; embedding?: number[] }[]; usage?: { prompt_tokens?: number } };
        const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (rows.length !== req.input.length || rows.some((r) => !Array.isArray(r.embedding))) {
          throw new ToolError("provider_error", `embeddings answer has ${rows.length} vectors for ${req.input.length} inputs`);
        }
        return { vectors: rows.map((r) => r.embedding!), ...(body.usage?.prompt_tokens !== undefined ? { usage: { inputTokens: body.usage.prompt_tokens } } : {}) };
      },
    });
  },
});

/**
 * `options.promptCacheKey` (Sinty's own option, never sent as is): `true` sends `prompt_cache_key` (the core's
 * per-session `cacheKey`), `false` never does. Unset: only for api.openai.com, because some compatible servers reject
 * unknown fields. DeepSeek caches prefixes on its own and needs no key.
 */
export function buildBody(req: ProviderRequest): Record<string, unknown> {
  const { promptCacheKey, ...options } = req.endpoint.options ?? {};
  const baseUrl = req.endpoint.baseUrl ?? "https://api.openai.com/v1";
  const sendKey = promptCacheKey === true || (promptCacheKey === undefined && /^https:\/\/api\.openai\.com(\/|$)/.test(baseUrl));
  const body: Record<string, unknown> = {
    model: req.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: req.messages.map(toWireMessage),
    ...(sendKey && req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
    ...options,
  };
  if (req.maxOutputTokens) body.max_tokens = req.maxOutputTokens;
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  }
  if (req.reasoning && req.reasoning !== "off") body.reasoning_effort = req.reasoning;
  return body;
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
    };
  }
  if (m.images?.length) {
    return {
      role: m.role,
      content: [{ type: "text", text: m.content }, ...m.images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } }))],
    };
  }
  return { role: m.role, content: m.content };
}

/**
 * Usage from the final chunk. Prompt cache: DeepSeek reports `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 * (and sometimes also `prompt_tokens_details.cached_tokens`); OpenAI reports `prompt_tokens_details.cached_tokens`.
 */
export function usageOf(u: NonNullable<ChatChunk["usage"]>): Extract<ProviderChunk, { type: "done" }>["usage"] {
  const input = u.prompt_tokens ?? 0;
  const hit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens;
  const miss = u.prompt_cache_miss_tokens ?? (hit !== undefined ? Math.max(0, input - hit) : undefined);
  return {
    inputTokens: input,
    outputTokens: u.completion_tokens ?? 0,
    ...(hit ? { cachedTokens: hit } : {}),
    ...(miss !== undefined ? { cacheMissTokens: miss } : {}),
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

export interface ChatChunk {
  error?: { message?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}
