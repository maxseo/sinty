import { definePlugin, parseSSE, ToolError, type ChatMessage, type ProviderRequest } from "@sinty/sdk";

const VERSION = "2023-06-01";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

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
        let inputTokens = 0;
        let cachedTokens = 0;
        let outputTokens = 0;
        let stopReason = "end_turn";

        for await (const msg of parseSSE(res.body, req.signal)) {
          const ev = JSON.parse(msg.data) as StreamEvent;
          switch (ev.type) {
            case "message_start":
              inputTokens = ev.message?.usage?.input_tokens ?? 0;
              cachedTokens = ev.message?.usage?.cache_read_input_tokens ?? 0;
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
        yield { type: "done", stopReason, usage: { inputTokens, outputTokens, ...(cachedTokens ? { cachedTokens } : {}) } };
      },
    });
  },
});

function buildBody(req: ProviderRequest): Record<string, unknown> {
  const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxOutputTokens ?? 8192,
    stream: true,
    messages: toWireMessages(req.messages.filter((m) => m.role !== "system")),
    ...req.endpoint.options,
  };
  if (system) body.system = system;
  if (req.tools.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  return body;
}

/** Anthropic needs alternating roles and tool results as user content blocks. */
function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  const push = (role: WireMessage["role"], blocks: Block[]): void => {
    if (!blocks.length) return;
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "tool") {
      const isError = m.content.startsWith("ERROR ") || m.content.startsWith("DENIED:");
      push("user", [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content, ...(isError ? { is_error: true } : {}) }]);
    } else if (m.role === "assistant") {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      push("assistant", blocks);
    } else {
      push("user", [{ type: "text", text: m.content }]);
    }
  }
  return out;
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
  message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number } };
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}
