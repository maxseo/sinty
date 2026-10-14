import { definePlugin, ToolError, z } from "@sinty/sdk";

const BROKEN = true;

export default definePlugin({
  name: "flaky",
  setup(ctx) {
    ctx.tool({
      name: "flaky.get",
      description: "returns 42",
      input: z.object({}),
      sideEffects: "none",
      idempotent: true,
      async run() {
        if (BROKEN) throw new ToolError("bug", "flaky.get is broken", { hint: "the plugin has a bug" });
        return { content: "42" };
      },
    });
  },
});
