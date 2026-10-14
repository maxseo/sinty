import { definePlugin, ToolError } from "@sinty/sdk";

/** String args like "$last.patchId" are replaced with that field of the last tool result (parsed as JSON). */
function fromLastTool(args, messages) {
  if (!args || typeof args !== "object") return args;
  const last = [...messages].reverse().find((m) => m.role === "tool");
  let parsed;
  try {
    parsed = JSON.parse(last?.content ?? "null");
  } catch {
    parsed = null;
  }
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => [k, typeof v === "string" && v.startsWith("$last.") ? parsed?.[v.slice(6)] : v]),
  );
}

export default definePlugin({
  name: "fake-provider",
  setup(ctx) {
    ctx.provider({
      protocol: "fake",
      async *stream(req) {
        if (req.endpoint.options?.fail) throw new ToolError("http_503", "fake outage", { retryable: true });
        const script = req.endpoint.options?.script ?? [];
        const n = req.messages.filter((m) => m.role === "assistant").length;
        const step = script[n] ?? { text: `fallthrough ${n}` };
        if (step.echoLastTool) {
          const last = [...req.messages].reverse().find((m) => m.role === "tool");
          yield { type: "text", text: `last tool: ${last?.content ?? "none"}` };
        }
        if (step.text) {
          for (const part of step.text.match(/.{1,4}/gs) ?? []) yield { type: "text", text: part };
        }
        for (const [i, c] of (step.toolCalls ?? []).entries()) {
          yield { type: "tool_call", id: `call_${n}_${i}`, name: c.name, args: fromLastTool(c.args, req.messages) };
        }
        yield { type: "done", stopReason: step.toolCalls ? "tool_use" : "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };
      },
    });
  },
});
