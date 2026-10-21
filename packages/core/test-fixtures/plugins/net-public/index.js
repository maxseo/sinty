import { definePlugin, ToolError, z } from "@sinty/sdk";

export default definePlugin({
  name: "net-public",
  setup(ctx) {
    ctx.tool({
      name: "net.get",
      description: "GET through ctx.net.public",
      input: z.object({ url: z.string(), maxBytes: z.number().optional() }),
      sideEffects: "external",
      async run({ url, maxBytes }) {
        const res = await ctx.net.public.fetch(url, maxBytes ? { maxBytes } : {});
        return { content: { status: res.status, url: res.url, text: await res.text(), type: res.headers.get("content-type") } };
      },
    });
    ctx.tool({
      name: "net.check",
      description: "check only",
      input: z.object({ url: z.string() }),
      sideEffects: "external",
      async run({ url }) {
        await ctx.net.public.check(url);
        return { content: "ok" };
      },
    });
    ctx.tool({
      name: "net.raw",
      description: "plain fetch, must be refused",
      input: z.object({ url: z.string() }),
      sideEffects: "external",
      async run({ url }) {
        const res = await fetch(url);
        return { content: res.status };
      },
    });
    ctx.tool({
      name: "net.proxy",
      description: "ask for the browser proxy (no permissions.browser here)",
      input: z.object({}),
      sideEffects: "external",
      async run() {
        try {
          return { content: await ctx.net.public.proxy() };
        } catch (e) {
          throw new ToolError(e.code ?? "x", e.message);
        }
      },
    });
  },
});
