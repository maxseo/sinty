import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSSE, definePlugin, describeOutcome, runTurn, z, type SintyEvent, type StreamEvent } from "@sinty/sdk";

const content = z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()), z.null()]);
const chatRequest = z
  .object({
    model: z.string().default("sinty"),
    messages: z.array(z.object({ role: z.string(), content: content.optional() }).loose()).min(1),
    stream: z.boolean().default(false),
    user: z.string().max(200).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

type ChatRequest = z.infer<typeof chatRequest>;

function textOf(c: ChatRequest["messages"][number]["content"]): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => p.text ?? "").join("");
  return "";
}

/** The agent keeps its own history, so only the newest user message is sent; earlier messages are a preamble for new sessions. */
function promptFrom(messages: ChatRequest["messages"], fresh: boolean): string {
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  const last = lastUser >= 0 ? textOf(messages[lastUser]!.content) : "";
  const system = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content));
  const before = fresh ? messages.slice(0, Math.max(0, lastUser)).filter((m) => m.role === "user" || m.role === "assistant") : [];
  const parts: string[] = [];
  if (system.length && fresh) parts.push(`Instructions from the client application:\n${system.join("\n")}`);
  if (before.length) parts.push(`Conversation so far:\n${before.map((m) => `${m.role}: ${textOf(m.content)}`).join("\n")}`);
  parts.push(last);
  return parts.join("\n\n");
}

class SessionMap {
  private readonly file: string;
  private readonly map: Record<string, string>;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "sessions.json");
    this.map = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>) : {};
  }
  get(key: string): string | undefined {
    return this.map[key];
  }
  set(key: string, sessionId: string): void {
    this.map[key] = sessionId;
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.map, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

export default definePlugin({
  name: "server-openai-api",
  setup(ctx) {
    const sessions = new SessionMap(ctx.paths.data);
    const created = Math.floor(Date.now() / 1000);

    ctx.http({
      method: "GET",
      path: "/v1/models",
      handler: () => Response.json({ object: "list", data: [{ id: "sinty", object: "model", created, owned_by: "sinty" }] }),
    });

    ctx.http({
      method: "POST",
      path: "/v1/chat/completions",
      async handler(req, { signal }) {
        const parsed = chatRequest.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: { message: z.prettifyError(parsed.error), type: "invalid_request_error" } }, { status: 400 });
        const body = parsed.data;

        const explicit = req.headers.get("x-sinty-session") ?? (typeof body.metadata?.session_id === "string" ? body.metadata.session_id : undefined);
        const key = explicit ? undefined : body.user ? `user:${body.user}` : undefined;
        let sessionId = explicit ?? (key ? sessions.get(key) : undefined);
        let fresh = false;
        if (sessionId && !(await ctx.agent.getSession(sessionId))) {
          if (explicit) return Response.json({ error: { message: `session ${sessionId} not found`, type: "invalid_request_error" } }, { status: 404 });
          sessionId = undefined;
        }
        if (!sessionId) {
          const s = await ctx.agent.createSession({ title: textOf(body.messages.at(-1)?.content).slice(0, 80) || "OpenAI API", metadata: { via: "openai-api", ...(body.user ? { user: body.user } : {}) } });
          sessionId = s.id;
          fresh = true;
          if (key) sessions.set(key, sessionId);
        }
        const prompt = promptFrom(body.messages, fresh);
        const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const headers = { "x-sinty-session": sessionId };

        if (!body.stream) {
          const outcome = await runTurn(ctx.agent, sessionId, prompt, { signal, channel: "openai-api" });
          return Response.json(
            {
              id,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [{ index: 0, message: { role: "assistant", content: describeOutcome(outcome, sessionId) }, finish_reason: "stop" }],
              usage: { prompt_tokens: outcome.usage.inputTokens, completion_tokens: outcome.usage.outputTokens, total_tokens: outcome.usage.inputTokens + outcome.usage.outputTokens },
              sinty: { session_id: sessionId, turn_id: outcome.turnId, status: outcome.status },
            },
            { headers },
          );
        }

        const sse = createSSE(signal, headers);
        const chunk = (delta: Record<string, unknown>, finish: string | null = null): void => {
          sse.send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] });
        };
        const sid = sessionId;
        void (async () => {
          chunk({ role: "assistant", content: "" });
          let streamed = false;
          try {
            const outcome = await runTurn(ctx.agent, sid, prompt, {
              signal,
              channel: "openai-api",
              onEvent(e) {
                const delta = e.type === "model.delta" ? (e as StreamEvent & { type: "model.delta" }).data.text : undefined;
                if (delta) {
                  streamed = true;
                  chunk({ content: delta });
                } else if (e.type === "tool.call.started") {
                  const d = (e as SintyEvent<"tool.call.started">).data;
                  if (streamed) chunk({ content: "\n" });
                  chunk({ content: `[${d.tool}]\n` });
                }
              },
            });
            if (outcome.status !== "completed" || !streamed) {
              const tail = outcome.status === "completed" ? outcome.text : describeOutcome({ ...outcome, text: "" }, sid);
              if (tail) chunk({ content: streamed ? `\n\n${tail}` : tail });
            }
            chunk({}, "stop");
          } catch (e) {
            chunk({ content: `\n\n[Sinty error: ${e instanceof Error ? e.message : String(e)}]` }, "stop");
          }
          sse.send("[DONE]");
          sse.close();
        })();
        return sse.response;
      },
    });
  },
});
