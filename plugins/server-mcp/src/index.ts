import { definePlugin, describeOutcome, runTurn, z, type AgentApi } from "@sinty/sdk";

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

interface McpTool {
  name: string;
  description: string;
  input: z.ZodObject;
  annotations: Record<string, boolean>;
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
}

const text = (t: string, structured?: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: t }], ...(structured ? { structuredContent: structured } : {}) });

function tools(agent: AgentApi, defaultTitle: string): McpTool[] {
  return [
    {
      name: "sinty_ask",
      description:
        "Give the Sinty agent a task or a message and wait for its answer. Pass session_id to continue a conversation; without it a new session starts. The agent may stop to wait for a human approval; the answer then says so.",
      input: z.object({ message: z.string().min(1), session_id: z.string().optional(), title: z.string().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async run(a, signal) {
        let sessionId = a.session_id as string | undefined;
        if (sessionId && !(await agent.getSession(sessionId))) return { ...text(`session ${sessionId} not found`), isError: true };
        if (!sessionId) sessionId = (await agent.createSession({ title: (a.title as string | undefined) ?? (String(a.message).slice(0, 80) || defaultTitle), metadata: { via: "mcp" } })).id;
        const o = await runTurn(agent, sessionId, String(a.message), { signal, channel: "mcp" });
        return { ...text(describeOutcome(o, sessionId), { session_id: sessionId, turn_id: o.turnId, status: o.status, text: o.text }), ...(o.status === "failed" ? { isError: true } : {}) };
      },
    },
    {
      name: "sinty_sessions",
      description: "List recent Sinty sessions with their status (running, blocked or idle).",
      input: z.object({ limit: z.number().int().min(1).max(200).optional() }),
      annotations: { readOnlyHint: true },
      async run(a) {
        const list = await agent.listSessions({ limit: (a.limit as number | undefined) ?? 20 });
        const rows = list.map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, status: s.activeTurn?.status ?? "idle" }));
        return text(rows.map((r) => `${r.id}  ${r.status.padEnd(7)}  ${r.title ?? ""}`).join("\n") || "no sessions", { sessions: rows });
      },
    },
    {
      name: "sinty_session_messages",
      description: "Read the conversation of a Sinty session: user and agent messages, in order.",
      input: z.object({ session_id: z.string(), limit: z.number().int().min(1).max(500).optional() }),
      annotations: { readOnlyHint: true },
      async run(a) {
        const events = await agent.events(String(a.session_id), { types: ["message.user", "message.agent"] });
        const msgs = events.slice(-((a.limit as number | undefined) ?? 50)).map((e) => ({ role: e.type === "message.user" ? "user" : "agent", text: (e.data as { text: string }).text, ts: e.ts }));
        return text(msgs.map((m) => `${m.role}: ${m.text}`).join("\n\n") || "no messages", { messages: msgs });
      },
    },
  ];
}

export default definePlugin({
  name: "server-mcp",
  setup(ctx) {
    const list = tools(ctx.agent, "MCP task");
    const byName = new Map(list.map((t) => [t.name, t]));

    async function handle(msg: RpcRequest, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
      const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
      const error = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
      if (msg.id === undefined || msg.id === null) return undefined;
      switch (msg.method) {
        case "initialize": {
          const asked = String(msg.params?.protocolVersion ?? "");
          return reply({
            protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "sinty", title: "Sinty agent", version: "0.1.0" },
            instructions: "Use sinty_ask to hand tasks to the Sinty agent. Keep the returned session_id to continue the same conversation.",
          });
        }
        case "ping":
          return reply({});
        case "tools/list":
          return reply({
            tools: list.map((t) => {
              const { $schema: _s, ...schema } = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
              return { name: t.name, description: t.description, inputSchema: schema, annotations: t.annotations };
            }),
          });
        case "tools/call": {
          const tool = byName.get(String(msg.params?.name));
          if (!tool) return error(-32602, `unknown tool ${String(msg.params?.name)}`);
          const parsed = tool.input.safeParse(msg.params?.arguments ?? {});
          if (!parsed.success) return reply({ ...text(z.prettifyError(parsed.error)), isError: true });
          try {
            return reply(await tool.run(parsed.data as Record<string, unknown>, signal));
          } catch (e) {
            return reply({ ...text(e instanceof Error ? e.message : String(e)), isError: true });
          }
        }
        default:
          return error(-32601, `method ${msg.method} not found`);
      }
    }

    ctx.http({
      method: "POST",
      path: "/mcp",
      async handler(req, { signal }) {
        const body: unknown = await req.json().catch(() => undefined);
        if (body === undefined) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
        const batch = Array.isArray(body);
        const msgs = (batch ? body : [body]) as RpcRequest[];
        const replies = (await Promise.all(msgs.map((m) => handle(m, signal)))).filter((r): r is Record<string, unknown> => r !== undefined);
        if (!replies.length) return new Response(null, { status: 202 });
        return Response.json(batch ? replies : replies[0]);
      },
    });

    ctx.http({
      method: "GET",
      path: "/mcp",
      handler: () => new Response("this server does not open server-to-client streams", { status: 405, headers: { allow: "POST" } }),
    });
  },
});
