import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSSE, definePlugin, runTurn, z, type LiveEvent, type SintyEvent, type StreamEvent } from "@sinty/sdk";

const runInput = z
  .object({
    threadId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200).optional(),
    messages: z.array(z.object({ id: z.string().optional(), role: z.string(), content: z.unknown().optional() }).loose()).default([]),
    state: z.unknown().optional(),
    tools: z.array(z.unknown()).optional(),
    context: z.array(z.object({ description: z.string(), value: z.string() }).loose()).optional(),
    forwardedProps: z.unknown().optional(),
  })
  .loose();

function textOf(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("");
  return "";
}

class Threads {
  private readonly file: string;
  private readonly map: Record<string, string>;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "threads.json");
    this.map = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>) : {};
  }
  get(thread: string): string | undefined {
    return this.map[thread];
  }
  set(thread: string, sessionId: string): void {
    this.map[thread] = sessionId;
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.map, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

/** Maps Sinty events of one turn to AG-UI events (https://docs.ag-ui.com/concepts/events). */
class Translator {
  private messageId: string | undefined;
  private open = false;
  constructor(private readonly emit: (e: Record<string, unknown>) => void) {}

  on(e: LiveEvent): void {
    switch (e.type) {
      case "model.request":
        this.messageId = randomUUID();
        this.emit({ type: "STEP_STARTED", stepName: "model" });
        break;
      case "model.delta": {
        const text = (e as StreamEvent & { type: "model.delta" }).data.text;
        if (!text) break;
        if (!this.open) {
          this.messageId ??= randomUUID();
          this.emit({ type: "TEXT_MESSAGE_START", messageId: this.messageId, role: "assistant" });
          this.open = true;
        }
        this.emit({ type: "TEXT_MESSAGE_CONTENT", messageId: this.messageId, delta: text });
        break;
      }
      case "model.response": {
        const d = (e as SintyEvent<"model.response">).data;
        if (this.open) this.emit({ type: "TEXT_MESSAGE_END", messageId: this.messageId });
        this.open = false;
        for (const c of d.toolCalls) {
          this.emit({ type: "TOOL_CALL_START", toolCallId: c.callId, toolCallName: c.tool, parentMessageId: this.messageId });
          this.emit({ type: "TOOL_CALL_ARGS", toolCallId: c.callId, delta: JSON.stringify(c.args ?? {}) });
          this.emit({ type: "TOOL_CALL_END", toolCallId: c.callId });
        }
        this.emit({ type: "STEP_FINISHED", stepName: "model" });
        break;
      }
      case "tool.call.completed":
      case "tool.call.failed":
      case "tool.call.denied": {
        const d = e.data as { callId: string; result?: unknown; code?: string; message?: string; note?: string };
        const content =
          e.type === "tool.call.completed" ? (typeof d.result === "string" ? d.result : JSON.stringify(d.result)) : e.type === "tool.call.failed" ? `ERROR ${d.code}: ${d.message}` : `DENIED: ${d.note ?? ""}`;
        this.emit({ type: "TOOL_CALL_RESULT", messageId: randomUUID(), toolCallId: d.callId, content, role: "tool" });
        break;
      }
      case "tool.call.approval_requested":
      case "supervisor.notice":
      case "supervisor.escalated":
        this.emit({ type: "CUSTOM", name: `sinty.${e.type}`, value: e.data });
        break;
    }
  }

  close(): void {
    if (this.open) this.emit({ type: "TEXT_MESSAGE_END", messageId: this.messageId });
    this.open = false;
  }
}

export default definePlugin({
  name: "server-agui",
  setup(ctx) {
    const threads = new Threads(ctx.paths.data);

    ctx.http({
      method: "POST",
      path: "/agui",
      async handler(req, { signal }) {
        const parsed = runInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
        const input = parsed.data;
        const runId = input.runId ?? randomUUID();
        const last = input.messages.findLast((m) => m.role === "user");
        const text = last ? textOf(last.content) : "";

        const sse = createSSE(signal);
        const emit = (e: Record<string, unknown>): void => {
          sse.send({ ...e, timestamp: Date.now() });
        };
        emit({ type: "RUN_STARTED", threadId: input.threadId, runId });
        if (!text.trim()) {
          emit({ type: "RUN_ERROR", message: "no user message in input.messages", code: "bad_request" });
          sse.close();
          return sse.response;
        }

        void (async () => {
          const t = new Translator(emit);
          try {
            let sessionId = threads.get(input.threadId) ?? (input.threadId.startsWith("ses_") && (await ctx.agent.getSession(input.threadId)) ? input.threadId : undefined);
            if (!sessionId) {
              sessionId = (await ctx.agent.createSession({ title: text.slice(0, 80), metadata: { via: "ag-ui", threadId: input.threadId } })).id;
              threads.set(input.threadId, sessionId);
            }
            const contextText = input.context?.length ? `\n\nContext from the app:\n${input.context.map((c) => `- ${c.description}: ${c.value}`).join("\n")}` : "";
            const o = await runTurn(ctx.agent, sessionId, text + contextText, { signal, channel: "ag-ui", onEvent: (e) => t.on(e) });
            t.close();
            emit({ type: "STATE_SNAPSHOT", snapshot: { sessionId, turnId: o.turnId, status: o.status, ...(o.blocked ? { blocked: o.blocked } : {}) } });
            if (o.status === "failed") emit({ type: "RUN_ERROR", message: o.error?.message ?? "turn failed", code: o.error?.code ?? "failed" });
            else emit({ type: "RUN_FINISHED", threadId: input.threadId, runId, result: { sessionId, status: o.status, text: o.text } });
          } catch (e) {
            t.close();
            emit({ type: "RUN_ERROR", message: e instanceof Error ? e.message : String(e), code: "internal" });
          }
          sse.close();
        })();
        return sse.response;
      },
    });
  },
});
