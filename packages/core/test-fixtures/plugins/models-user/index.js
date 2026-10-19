import { definePlugin, z } from "@sinty/sdk";

export default definePlugin({
  name: "models-user",
  setup(ctx) {
    ctx.tool({
      name: "models.ask",
      description: "asks a model through the core",
      input: z.object({ text: z.string(), route: z.string().optional() }),
      sideEffects: "none",
      idempotent: true,
      run: async ({ text, route }, c) => {
        const r = await ctx.models.complete({ route: route ?? "cheap", messages: [{ role: "user", content: text }], maxOutputTokens: 50, sessionId: c.sessionId });
        return { content: { text: r.text, provider: r.provider, model: r.model } };
      },
    });
    ctx.tool({
      name: "models.vec",
      description: "embeds through the core",
      input: z.object({ texts: z.array(z.string()) }),
      sideEffects: "none",
      idempotent: true,
      run: async ({ texts }, c) => {
        const r = await ctx.models.embed({ input: texts, sessionId: c.sessionId });
        return { content: { n: r.vectors.length, width: r.vectors[0]?.length ?? 0, model: r.model } };
      },
    });
  },
});
