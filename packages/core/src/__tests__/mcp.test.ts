import assert from "node:assert/strict";
import { test } from "node:test";
import { policySchema } from "../config.js";
import { boot, find, tempHome } from "./helpers.js";

test("mcp-stdio plugin tools go through the turn", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(
    home,
    [{ toolCalls: [{ name: "mcp-echo__ping", args: { text: "pong" } }] }, { text: "done" }],
    { policy: policySchema.parse({ defaults: { none: "allow", read: "allow", write: "allow", external: "allow" } }), plugins: ["fake-provider", "mcp-echo"] },
  );
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "ping");
    await sinty.agent.idle();
    const events = sinty.journal.events(s.id);
    assert.equal(find<{ result: unknown }>(events, "tool.call.completed")?.result, "pong");
  } finally {
    await sinty.stop();
    cleanup();
  }
});
