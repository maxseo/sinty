import assert from "node:assert/strict";
import { test } from "node:test";
import { Sinty } from "../sinty.js";
import { tempHome, testConfig } from "./helpers.js";

test("host: a plugin cannot register a tool with a core tool name", async () => {
  const { home, cleanup } = tempHome();
  const sinty = new Sinty({ home, config: testConfig([{ text: "hi" }], {}, ["fake-provider", "shadow-core"]) });
  try {
    const { failedPlugins } = await sinty.start();
    const failed = failedPlugins.find((f) => f.plugin === "shadow-core");
    assert.ok(failed, "shadow-core must fail to start");
    assert.match(failed.error, /memory\.write is reserved by the core/);
    assert.equal(sinty.host.toolOwner("memory.write"), undefined);
  } finally {
    await sinty.stop();
    cleanup();
  }
});
