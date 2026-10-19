import { definePlugin, ToolError, z } from "@sinty/sdk";

export default definePlugin({
  name: "syntet",
  setup(ctx) {
    const base = String(ctx.config.baseUrl ?? "https://syntet.ru").replace(/\/+$/, "");
    async function call(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<unknown> {
      const token = await ctx.secrets.get("syntet.token");
      const res = await ctx.net.fetch(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        ...(init.signal ? { signal: init.signal } : {}),
      });
      const text = await res.text();
      if (!res.ok) throw new ToolError(`http_${res.status}`, text.slice(0, 500), { retryable: res.status >= 500 });
      try { return JSON.parse(text) as unknown; } catch { return text; }
    }

    ctx.tool({
      name: "syntet.whoami",
      description: "Who this token is on the Syntet site.",
      input: z.object({}),
      sideEffects: "read",
      idempotent: true,
      async run(_a, { signal }) {
        return { content: await call(String(ctx.config.whoamiPath ?? "/api/ai-agent/me"), { signal }) };
      },
    });

    ctx.tool({
      name: "syntet.generations",
      description: "List recent generations for this account. kind is image, video, audio or 3d.",
      input: z.object({ kind: z.enum(["image", "video", "audio", "3d"]).default("image"), limit: z.number().int().min(1).max(50).default(10) }),
      sideEffects: "read",
      idempotent: true,
      async run({ kind, limit }, { signal }) {
        const path = String(ctx.config.generationsPath ?? "/api/generations");
        return { content: await call(`${path}?kind=${kind}&limit=${limit}`, { signal }) };
      },
    });

    ctx.tool({
      name: "syntet.record_usage",
      description: "Tell the site how many tokens this turn spent, so the account balance stays right.",
      input: z.object({ model: z.string().min(1), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), sessionId: z.string().optional() }),
      sideEffects: "external",
      async run(input, { signal, sessionId }) {
        return { content: await call(String(ctx.config.usagePath ?? "/api/usage"), { method: "POST", body: { ...input, sessionId: input.sessionId ?? sessionId }, signal }) };
      },
    });
  },
});
