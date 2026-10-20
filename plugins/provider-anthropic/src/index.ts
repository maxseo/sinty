import { definePlugin, parseSSE, ToolError, type ChatMessage, type ProviderRequest, type ProviderUsage } from "@sinty/sdk";

const VERSION = "2023-06-01";

type CacheControl = { type: "ephemeral"; ttl?: "1h" };

type Block = (
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
) & { cache_control?: CacheControl };

interface WireMessage {
  role: "user" | "assistant";
  content: Block[];
}

export default definePlugin({
  name: "provider-anthropic",
  setup(ctx) {
    ctx.provider({
      protocol: "anthropic",
      async *stream(req) {
        const baseUrl = (req.endpoint.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
        const res = await ctx.net.fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          signal: req.signal,
          headers: {
            "content-type": "application/json",
            "anthropic-version": VERSION,
            ...(req.endpoint.apiKey ? { "x-api-key": req.endpoint.apiKey } : {}),
            ...req.endpoint.headers,
          },
          body: JSON.stringify(buildBody(req)),
        });
        if (!res.ok || !res.body) throw await httpError(res);

        const tools = new Map<number, { id: string; name: string; json: string }>();
        let start: StartUsage = {};
        let outputTokens = 0;
        let stopReason = "end_turn";

        for await (const msg of parseSSE(res.body, req.signal)) {
          const ev = JSON.parse(msg.data) as StreamEvent;
          switch (ev.type) {
            case "message_start":
              start = ev.message?.usage ?? {};
              break;
            case "content_block_start":
              if (ev.content_block?.type === "tool_use") tools.set(ev.index ?? 0, { id: ev.content_block.id ?? "", name: ev.content_block.name ?? "", json: "" });
              break;
            case "content_block_delta":
              if (ev.delta?.type === "text_delta" && ev.delta.text) yield { type: "text", text: ev.delta.text };
              else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) yield { type: "reasoning", text: ev.delta.thinking };
              else if (ev.delta?.type === "input_json_delta") {
                const t = tools.get(ev.index ?? 0);
                if (t) t.json += ev.delta.partial_json ?? "";
              }
              break;
            case "content_block_stop": {
              const t = tools.get(ev.index ?? 0);
              if (t) {
                yield { type: "tool_call", id: t.id, name: t.name, args: parseArgs(t.json) };
                tools.delete(ev.index ?? 0);
              }
              break;
            }
            case "message_delta":
              if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
              if (ev.usage?.output_tokens !== undefined) outputTokens = ev.usage.output_tokens;
              break;
            case "error":
              throw new ToolError(ev.error?.type ?? "provider_error", ev.error?.message ?? "stream error", { retryable: ev.error?.type === "overloaded_error" });
          }
        }
        yield { type: "done", stopReason, usage: usageOf(start, outputTokens) };
      },
    });
  },
});

/**
 * Prompt caching (on by default): the core's cache hints become `cache_control` breakpoints (at most 4). A hint
 * marks the last message of a stable segment, so the breakpoint closes that segment.
 * - Leading system messages are `system` text blocks; the one hinted `static` (end of persona, rules and skills; also
 *   covers the tools, which come first in Anthropic's prefix) and `session` (end of memory snapshot and summary) get one.
 * - The message hinted `turn` (the last dialogue message) gets one on its last block, so the next step reads the whole
 *   conversation so far from the cache.
 * - System messages after the first non-system message (context plugins' tail notes) are sent in place as user text
 *   inside `<system>`, instead of being merged into `system`, which would rewrite the cached prefix on every step.
 * Options (Sinty's own, never sent as is): `promptCache: false` turns breakpoints off, `cacheTtl: "1h"` asks for the
 * one-hour cache (billed higher on writes) instead of the default five minutes.
 */
export function buildBody(req: ProviderRequest): Record<string, unknown> {
  const { promptCache, cacheTtl, ...options } = req.endpoint.options ?? {};
  const cc: CacheControl | undefined = promptCache === false ? undefined : cacheTtl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  const lead = req.messages.findIndex((m) => m.role !== "system");
  const head = lead < 0 ? req.messages : req.messages.slice(0, lead);
  const rest = lead < 0 ? [] : req.messages.slice(lead);
  // Anthropic allows 4 breakpoints: when more messages are hinted, the turn tail keeps its one and the head the last 3.
  let hinted = req.messages.filter((m) => m.cacheHint);
  if (hinted.length > 4) hinted = [...hinted.filter((m) => m.cacheHint !== "turn").slice(-3), ...hinted.filter((m) => m.cacheHint === "turn").slice(-1)];
  const marked = new Set(hinted);
  const mark = (m: ChatMessage): CacheControl | undefined => (cc && marked.has(m) ? cc : undefined);
  const system: Block[] = head.filter((m) => m.content).map((m) => {
    const c = mark(m);
    return { type: "text", text: m.content, ...(c ? { cache_control: c } : {}) };
  });
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxOutputTokens ?? 8192,
    stream: true,
    messages: toWireMessages(rest, mark),
    ...options,
  };
  if (system.length) body.system = system;
  if (req.tools.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  return body;
}

/** Anthropic needs alternating roles and tool results as user content blocks. */
function toWireMessages(messages: ChatMessage[], mark: (m: ChatMessage) => CacheControl | undefined = () => undefined): WireMessage[] {
  const out: WireMessage[] = [];
  const push = (role: WireMessage["role"], blocks: Block[], cache?: CacheControl): void => {
    if (!blocks.length) return;
    if (cache) blocks[blocks.length - 1] = { ...blocks[blocks.length - 1]!, cache_control: cache };
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "tool") {
      const isError = m.content.startsWith("ERROR ") || m.content.startsWith("DENIED:");
      push("user", [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content, ...(isError ? { is_error: true } : {}) }], mark(m));
    } else if (m.role === "assistant") {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      push("assistant", blocks, blocks.length ? mark(m) : undefined);
    } else if (m.role === "system") {
      push("user", [{ type: "text", text: `<system>\n${m.content}\n</system>` }], mark(m));
    } else {
      push("user", [{ type: "text", text: m.content }], mark(m));
    }
  }
  return out;
}

/**
 * With caching, Anthropic's `input_tokens` counts only the tokens after the last breakpoint; the whole prompt is
 * input + cache read + cache write. Sinty's `inputTokens` is always the whole prompt.
 */
export function usageOf(u: StartUsage, outputTokens: number): ProviderUsage {
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const plain = u.input_tokens ?? 0;
  return {
    inputTokens: plain + read + write,
    outputTokens,
    ...(read ? { cachedTokens: read } : {}),
    ...(u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined ? { cacheMissTokens: plain + write } : {}),
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
  return new ToolError(`http_${res.status}`, text.slice(0, 1000) || res.statusText, {
    retryable: res.status === 429 || res.status === 529 || res.status >= 500,
    ...(res.status === 401 ? { hint: "Check the Anthropic API key: sinty secret set anthropic" } : {}),
  });
}

interface StreamEvent {
  type: string;
  index?: number;
  message?: { usage?: StartUsage };
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

interface StartUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
