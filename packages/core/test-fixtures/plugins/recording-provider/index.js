import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "@sinty/sdk";

/**
 * options.script: { "<last user text>": [step, step, ...] }, step = { text?, toolCalls?: [{ name, args }] }.
 * The step index is the number of assistant messages after the last user message.
 * A request whose only message asks for JSON (the summary call) gets options.summary back.
 * options.embed: when true the provider also answers embeddings with a tiny bag-of-letters vector.
 */
export default definePlugin({
  name: "recording-provider",
  setup(ctx) {
    mkdirSync(ctx.paths.data, { recursive: true });
    const file = join(ctx.paths.data, "requests.jsonl");
    const record = (row) => appendFileSync(file, JSON.stringify(row) + "\n");
    ctx.provider({
      protocol: "rec",
      async *stream(req) {
        record({ model: req.model, messages: req.messages, tools: req.tools.map((t) => t.name), maxOutputTokens: req.maxOutputTokens });
        const opts = req.endpoint.options ?? {};
        const only = req.messages.length === 1 ? req.messages[0] : undefined;
        if (only && only.role === "user" && only.content.includes("Reply with JSON only")) {
          yield { type: "text", text: JSON.stringify(opts.summary ?? { summary: "Earlier talk folded.", facts: [] }) };
          yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 3 } };
          return;
        }
        if (opts.reply && only && only.role === "user") {
          yield { type: "text", text: String(opts.reply) };
          yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 3 } };
          return;
        }
        let lastUser = -1;
        req.messages.forEach((m, i) => {
          if (m.role === "user" && !m.content.startsWith("[supervisor]")) lastUser = i;
        });
        const userText = lastUser >= 0 ? req.messages[lastUser].content : "";
        const n = req.messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
        const steps = (opts.script ?? {})[userText] ?? [{ text: `ok: ${userText.slice(0, 20)}` }];
        const step = steps[n] ?? { text: "done" };
        if (step.text) yield { type: "text", text: step.text };
        for (const [i, c] of (step.toolCalls ?? []).entries()) yield { type: "tool_call", id: `call_${lastUser}_${n}_${i}`, name: c.name, args: c.args };
        yield { type: "done", stopReason: step.toolCalls ? "tool_use" : "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };
      },
    });
  },
});
