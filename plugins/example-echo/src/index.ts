import { definePlugin, ToolError, z } from "@sinty/sdk";

export default definePlugin({
  name: "example-echo",
  setup(ctx) {
    ctx.tool({
      name: "echo.say",
      description: "Return the text back, optionally upper-cased",
      input: z.object({
        text: z.string().max(10_000),
        upper: z.boolean().optional(),
      }),
      sideEffects: "none",
      idempotent: true,
      async run({ text, upper }) {
        if (text.trim() === "") {
          throw new ToolError("empty_text", "Nothing to echo", { hint: "Pass a non-empty `text`." });
        }
        return { content: upper ? text.toUpperCase() : text };
      },
    });
  },
});
