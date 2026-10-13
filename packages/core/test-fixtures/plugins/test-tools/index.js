import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { definePlugin, z } from "@sinty/sdk";

export default definePlugin({
  name: "test-tools",
  setup(ctx) {
    ctx.tool({
      name: "echo.say",
      description: "echo",
      input: z.object({ text: z.string() }),
      sideEffects: "none",
      idempotent: true,
      async run({ text }) {
        return { content: text };
      },
    });
    ctx.tool({
      name: "side.effect",
      description: "appends a line to workspace/effects.log",
      input: z.object({ line: z.string() }),
      sideEffects: "write",
      async run({ line }) {
        appendFileSync(join(ctx.paths.workspace, "effects.log"), `${line}\n`);
        return { content: "ok" };
      },
    });
    ctx.tool({
      name: "crash.now",
      description: "kills the plugin process",
      input: z.object({}),
      sideEffects: "none",
      async run() {
        process.exit(7);
      },
    });
    ctx.tool({
      name: "sleep.long",
      description: "sleeps until cancelled",
      input: z.object({ ms: z.number() }),
      sideEffects: "none",
      async run({ ms }, { signal }) {
        await sleep(ms, undefined, { signal });
        return { content: "slept" };
      },
    });
  },
});
