import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, type EventType } from "@sinty/sdk";

const TYPES = new Set<EventType>(["turn.started", "turn.completed", "turn.failed", "model.request", "model.response", "tool.call.started", "tool.call.completed", "tool.call.failed", "usage.recorded"]);

export default definePlugin({
  name: "otel",
  setup(ctx) {
    mkdirSync(ctx.paths.data, { recursive: true });
    const file = join(ctx.paths.data, "spans.jsonl");
    const endpoint = typeof ctx.config.endpoint === "string" ? ctx.config.endpoint : "";
    ctx.on("*", (e) => {
      if (!TYPES.has(e.type)) return;
      const line = JSON.stringify({ name: e.type, ts: e.ts, sessionId: e.sessionId, turnId: e.turnId, data: e.data });
      appendFileSync(file, `${line}\n`);
      if (endpoint) {
        void ctx.net.fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: line }).catch((err: unknown) => {
          ctx.log.warn("otel post failed", err instanceof Error ? err.message : err);
        });
      }
    });
  },
});
