import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "@sinty/sdk";

/** Records every context snapshot; optionally adds a context message and a memory block so the trace has both. */
export default definePlugin({
  name: "inspect-noperm",
  setup(ctx) {
    mkdirSync(ctx.paths.data, { recursive: true });
    ctx.onContextSnapshot((s) => appendFileSync(join(ctx.paths.data, "snapshots.jsonl"), JSON.stringify(s) + "\n"));
    if (ctx.config.note) ctx.context("note", async ({ messages }) => [...messages, { role: "system", content: "[inspect-test] house rule: answer briefly" }], { order: 50 });
    if (ctx.config.block) {
      ctx.memory.processor({
        name: "inspect-noperm",
        async beforeContext(_turn, blocks) {
          return [...blocks, { id: "inspect.extra", content: "<extra>block from inspect-test</extra>", source: "inspect-test" }];
        },
      });
    }
  },
});
