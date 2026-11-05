import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../api/server.js";
import { DEFAULT_ON_PLUGINS } from "../config.js";
import { boot, tempHome } from "./helpers.js";

test("settings sections: plugin.usage is listed when usage is on by default", async () => {
  assert.ok(DEFAULT_ON_PLUGINS.includes("usage"));
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { plugins: ["fake-provider"] });
  try {
    assert.ok(sinty.config.plugins.enabled.includes("usage"));
    const app = createApp(sinty);
    const auth = { authorization: `Bearer ${sinty.secrets.get("api.token")!}` };
    const { sections } = (await (await app.request("/v1/settings/sections", { headers: auth })).json()) as {
      sections: { id: string; title: string; owner: string; plugin?: string }[];
    };
    const usage = sections.find((s) => s.id === "plugin.usage");
    assert.ok(usage, `expected plugin.usage in ${sections.map((s) => s.id).join(",")}`);
    assert.equal(usage.title, "Расход");
    assert.equal(usage.owner, "plugin");
    assert.equal(usage.plugin, "usage");
    const plugins = (await (await app.request("/v1/plugins", { headers: auth })).json()) as {
      plugins: { name: string; tabs?: { id: string; placement?: string; src?: string }[] }[];
    };
    const tab = plugins.plugins.find((p) => p.name === "usage")?.tabs?.find((t) => t.id === "spend");
    assert.equal(tab?.placement, "settings");
    assert.equal(tab?.src, "/p/usage/tab");
  } finally {
    await sinty.stop();
    cleanup();
  }
});
