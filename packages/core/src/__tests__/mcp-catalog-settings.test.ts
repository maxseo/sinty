import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../api/server.js";
import { DEFAULT_ON_PLUGINS } from "../config.js";
import { boot, tempHome } from "./helpers.js";

test("settings sections: plugin.mcp-catalog listed when mcp-catalog is DEFAULT_ON", async () => {
  assert.ok(DEFAULT_ON_PLUGINS.includes("mcp-catalog"));
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { plugins: ["fake-provider"] });
  try {
    assert.ok(sinty.config.plugins.enabled.includes("mcp-catalog"));
    const app = createApp(sinty);
    const auth = { authorization: `Bearer ${sinty.secrets.get("api.token")!}` };
    const { sections } = (await (await app.request("/v1/settings/sections", { headers: auth })).json()) as {
      sections: { id: string; title: string; owner: string; plugin?: string; values: Record<string, unknown> }[];
    };
    const mcp = sections.find((s) => s.id === "plugin.mcp-catalog");
    assert.ok(mcp, `expected plugin.mcp-catalog in ${sections.map((s) => s.id).join(",")}`);
    assert.equal(mcp.title, "MCP");
    assert.equal(mcp.owner, "plugin");
    assert.equal(mcp.plugin, "mcp-catalog");
    assert.equal(mcp.values.showDisabled, true);
  } finally {
    await sinty.stop();
    cleanup();
  }
});
