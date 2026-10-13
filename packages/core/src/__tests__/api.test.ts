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

    assert.equal((await app.request("/v1/health")).status, 200);
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
  } finally {
    await sinty.stop();
    cleanup();
  }
});
