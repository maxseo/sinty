import { definePlugin } from "@sinty/sdk";

/** A system section that answers once, then fails: the core must repeat its first text, not drop it. */
export default definePlugin({
  name: "section-flaky",
  setup(ctx) {
    let calls = 0;
    ctx.systemSection(
      "rules",
      (input) => {
        calls++;
        if (calls > 1) throw new Error("section backend is down");
        return `House rules for ${input.agent ? input.agent.name : "everyone"}.`;
      },
      { order: 50 },
    );
  },
});
