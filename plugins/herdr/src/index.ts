import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "@sinty/sdk";

export default definePlugin({
  name: "herdr",
  setup(ctx) {
    mkdirSync(ctx.paths.data, { recursive: true });
    const file = join(ctx.paths.data, "states.jsonl");
    const url = typeof ctx.config.url === "string" ? ctx.config.url : "";
    ctx.on("agent.state", async (e) => {
      const body = { sessionId: e.sessionId, state: e.data.state, ts: e.ts };
      appendFileSync(file, `${JSON.stringify(body)}\n`);
      if (!url) return;
      await ctx.net.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch((err: unknown) => {
        ctx.log.warn("herdr post failed", err instanceof Error ? err.message : err);
      });
    });
  },
});
