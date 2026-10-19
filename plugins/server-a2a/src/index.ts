import { definePlugin, runTurn, z } from "@sinty/sdk";

const part = z.object({ kind: z.string().optional(), text: z.string().optional() }).loose();
const send = z.object({
  message: z.object({
    role: z.string().optional(),
    parts: z.array(part).optional(),
    content: z.string().optional(),
  }).loose(),
  contextId: z.string().optional(),
}).loose();

function textOf(m: z.infer<typeof send>["message"]): string {
  if (m.content) return m.content;
  return (m.parts ?? []).map((p) => p.text ?? "").join("");
}

export default definePlugin({
  name: "server-a2a",
  setup(ctx) {
    ctx.http({
      method: "GET",
      path: "/.well-known/agent-card.json",
      handler: () =>
        Response.json({
          name: "Sinty",
          description: "Sinty agent",
          version: "0.1.0",
          protocolVersion: "0.3.0",
          skills: [{ id: "chat", name: "Chat", description: "Give Sinty a task" }],
          capabilities: { streaming: false },
        }),
    });

    ctx.http({
      method: "POST",
      path: "/a2a",
      async handler(req, { signal }) {
        const rpc = (await req.json().catch(() => null)) as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown } | null;
        if (!rpc || rpc.method !== "message/send") {
          return Response.json({ jsonrpc: "2.0", id: rpc?.id ?? null, error: { code: -32601, message: "only message/send is implemented" } }, { status: 400 });
        }
        const parsed = send.safeParse(rpc.params ?? {});
        if (!parsed.success) return Response.json({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32602, message: z.prettifyError(parsed.error) } });
        const text = textOf(parsed.data.message).trim();
        if (!text) return Response.json({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32602, message: "empty message" } });
        let sessionId = parsed.data.contextId;
        if (!sessionId || !(await ctx.agent.getSession(sessionId))) {
          sessionId = (await ctx.agent.createSession({ title: text.slice(0, 80), metadata: { via: "a2a" } })).id;
        }
        const outcome = await runTurn(ctx.agent, sessionId, text, { signal, channel: "a2a" });
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          result: {
            id: outcome.turnId,
            contextId: sessionId,
            status: { state: outcome.status === "completed" ? "completed" : outcome.status === "blocked" ? "input-required" : "failed" },
            artifacts: [{ parts: [{ kind: "text", text: outcome.text }] }],
          },
        });
      },
    });
  },
});
