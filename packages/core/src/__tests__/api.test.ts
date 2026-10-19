import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../api/server.js";
import { policySchema } from "../config.js";
import { boot, tempHome } from "./helpers.js";

test("API: auth, session, message, events, idempotency", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ text: "hello from api" }], { policy: policySchema.parse({}) });
  try {
    const app = createApp(sinty);
    const token = sinty.secrets.get("api.token")!;
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const health = (await (await app.request("/v1/health")).json()) as { protocol: string };
    assert.equal(health.protocol, "sinty/1.0");
    assert.equal((await app.request("/v1/sessions")).status, 401);
    assert.equal((await app.request("/v1/sessions", { headers: { authorization: "Bearer wrong" } })).status, 401);

    const created = (await (await app.request("/v1/sessions", { method: "POST", headers: auth, body: JSON.stringify({ title: "t" }) })).json()) as { id: string };
    const send = () => app.request(`/v1/sessions/${created.id}/messages`, { method: "POST", headers: { ...auth, "idempotency-key": "same" }, body: JSON.stringify({ text: "hi" }) });
    const first = (await (await send()).json()) as { turnId: string };
    const second = (await (await send()).json()) as { turnId: string };
    assert.equal(first.turnId, second.turnId);

    await sinty.agent.idle();
    const { events } = (await (await app.request(`/v1/sessions/${created.id}/events`, { headers: auth })).json()) as { events: { type: string; data: { text?: string } }[] };
    assert.equal(events.find((e) => e.type === "message.agent")?.data.text, "hello from api");
    assert.equal(events.filter((e) => e.type === "turn.started").length, 1);

    const saved = await app.request("/v1/settings", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ model: "fake/other-model", fallback: [], enabled: ["ui-web"], agentsMd: "persona from settings" }),
    });
    assert.equal(saved.status, 200);
    assert.equal(sinty.config.models.default, "fake/other-model");
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(sinty.paths.agents, "utf8"), "persona from settings");
    assert.match(readFileSync(sinty.paths.config, "utf8"), /secret:\/\/anthropic/);
  } finally {
    await sinty.stop();
    cleanup();
  }
});
