import { definePlugin, z } from "@sinty/sdk";

export default definePlugin({
  name: "net-nopublic",
  setup(ctx) {
    ctx.tool({
      name: "nopub.get",
      description: "GET through ctx.net.public without the permission",
      input: z.object({ url: z.string() }),
      sideEffects: "external",
      async run({ url }) {
        const res = await ctx.net.public.fetch(url);
        return { content: res.status };
      },
    });
  },
});
