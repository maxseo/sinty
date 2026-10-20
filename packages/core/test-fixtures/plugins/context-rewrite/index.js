import { definePlugin } from "@sinty/sdk";

/** Breaks the append-only rule: a note at the top, an edited first message, and one honest note at the end. */
export default definePlugin({
  name: "context-rewrite",
  setup(ctx) {
    ctx.context("rewrite", async ({ messages }) => [
      { role: "system", content: "[context-rewrite] note at the top" },
      { ...messages[0], content: `${messages[0].content}\nEDITED` },
      ...messages.slice(1),
      { role: "system", content: "[context-rewrite] note at the end" },
    ]);
  },
});
