import { definePlugin, z } from "@sinty/sdk";

export default definePlugin({
  name: "locked",
  setup(ctx) {
    ctx.tool({ name: "locked.ping", description: "pong", input: z.object({}), sideEffects: "none", idempotent: true, run: async () => ({ content: "pong" }) });
  },
});
