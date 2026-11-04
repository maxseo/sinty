import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../api/server.js";
import { discoverPlugins } from "../discover.js";
import { installHomePlugin, PluginInstallError } from "../plugin-install.js";
import { parseDocument } from "yaml";
import { listAgents, saveAgent } from "../roster.js";
import { boot, tempHome } from "./helpers.js";

function writeMiniPlugin(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "sinty.plugin.json"),
    JSON.stringify({
      name,
      version: "0.1.0",
      description,
      kinds: ["tool"],
      runtime: "node",
      entry: "index.js",
      permissions: {},
    }) + "\n",
  );
  writeFileSync(
    join(dir, "index.js"),
    `import { definePlugin, z } from "@sinty/sdk";
export default definePlugin({
  name: "${name}",
  setup(ctx) {
    ctx.tool({
      name: "${name}.ping",
      description: "ping",
      input: z.object({}),
      sideEffects: "none",
      idempotent: true,
      async run() { return { content: "pong" }; },
    });
  },
});
`,
  );
}

const OFF_DEFAULTS = { plugins: { disabled: ["tool-web", "tool-vision", "tool-stt", "skills", "mcp-catalog", "responsive-turn"] } } as const;

test("discoverPlugins: includes home plugins that are not enabled", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { plugins: ["fake-provider"], config: OFF_DEFAULTS as never });
  try {
    writeMiniPlugin(join(home, "plugins", "home-only"), "home-only", "home catalog entry");
    const catalog = discoverPlugins(sinty.paths, sinty.config.plugins.searchPaths);
    assert.ok(catalog.some((p) => p.name === "home-only"));
    assert.ok(!sinty.config.plugins.enabled.includes("home-only"));
    const app = createApp(sinty);
    const token = sinty.secrets.get("api.token")!;
    const res = await app.request("/v1/settings", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { plugins: { name: string; enabled: boolean }[] };
    const row = body.plugins.find((p) => p.name === "home-only");
    assert.ok(row);
    assert.equal(row!.enabled, false);
  } finally {
    await sinty.stop();
    try { cleanup(); } catch { /* Windows may still hold journal handles briefly */ }
  }
});

test("installHomePlugin from path: copies, enables, hot-starts; rejects duplicate", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { plugins: ["fake-provider"], config: OFF_DEFAULTS as never });
  try {
    const src = join(home, "src-plugin", "path-echo");
    writeMiniPlugin(src, "path-echo", "installed from path");
    const result = await installHomePlugin(sinty.paths, sinty.config, sinty.host, { path: src });
    assert.equal(result.name, "path-echo");
    assert.equal(result.source, "path");
    assert.equal(result.started, true);
    assert.ok(existsSync(join(home, "plugins", "path-echo", "sinty.plugin.json")));
    assert.ok(sinty.config.plugins.enabled.includes("path-echo"));
    assert.ok(sinty.host.toolOwner("path-echo.ping"));

    await assert.rejects(
      () => installHomePlugin(sinty.paths, sinty.config, sinty.host, { path: src }),
      (e: unknown) => e instanceof PluginInstallError && e.code === "exists",
    );

    await assert.rejects(
      () => installHomePlugin(sinty.paths, sinty.config, sinty.host, { path: join(home, "missing") }),
      (e: unknown) => e instanceof PluginInstallError && e.code === "not_found",
    );

    await sinty.host.unload("path-echo");
  } finally {
    await sinty.stop();
    try { cleanup(); } catch { /* ignore */ }
  }
});

test("POST /v1/plugins/install: 401 without auth; installs with bearer from path", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { plugins: ["fake-provider"], config: OFF_DEFAULTS as never });
  try {
    const src = join(home, "stage", "api-path-plugin");
    writeMiniPlugin(src, "api-path-plugin", "api install fixture");
    const app = createApp(sinty);
    assert.equal((await app.request("/v1/plugins/install", { method: "POST", body: "{}" })).status, 401);
    const token = sinty.secrets.get("api.token")!;
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const res = await app.request("/v1/plugins/install", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ path: src }),
    });
    const text = await res.text();
    assert.equal(res.status, 201, text);
    const body = JSON.parse(text) as { name: string; started: boolean; location: string };
    assert.equal(body.name, "api-path-plugin");
    assert.equal(body.location, "home");
    assert.equal(body.started, true);
    await sinty.host.unload("api-path-plugin");
  } finally {
    await sinty.stop();
    try { cleanup(); } catch { /* ignore */ }
  }
});

test("home plugin: disable keeps data, delete removes the stub and its settings", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { plugins: ["fake-provider"], config: OFF_DEFAULTS as never });
  try {
    const src = join(home, "stage", "stub-keep");
    writeMiniPlugin(src, "stub-keep", "throwaway plugin");
    const app = createApp(sinty);
    const token = sinty.secrets.get("api.token")!;
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const installed = await app.request("/v1/plugins/install", { method: "POST", headers: auth, body: JSON.stringify({ path: src }) });
    assert.equal(installed.status, 201);
    mkdirSync(join(home, "data", "stub-keep"), { recursive: true });
    writeFileSync(join(home, "data", "stub-keep", "keep.txt"), "still here");
    const doc = parseDocument(readFileSync(sinty.paths.config, "utf8"));
    doc.setIn(["plugins", "config", "stub-keep", "note"], "keep-me");
    writeFileSync(sinty.paths.config, String(doc));
    saveAgent(sinty.paths, { name: "Stub", plugins: ["stub-keep"], excludedPlugins: ["stub-keep"] });

    const settings = (await (await app.request("/v1/settings", { headers: auth })).json()) as { model: string; plugins: { name: string; enabled: boolean }[] };
    const without = settings.plugins.filter((p) => p.enabled && p.name !== "stub-keep").map((p) => p.name);
    const off = await app.request("/v1/settings", { method: "PUT", headers: auth, body: JSON.stringify({ model: settings.model, enabled: without }) });
    assert.equal(off.status, 200);
    assert.equal(sinty.host.toolOwner("stub-keep.ping"), undefined);
    assert.equal(readFileSync(join(home, "data", "stub-keep", "keep.txt"), "utf8"), "still here");
    assert.match(readFileSync(sinty.paths.config, "utf8"), /keep-me/);

    const on = await app.request("/v1/settings", { method: "PUT", headers: auth, body: JSON.stringify({ model: settings.model, enabled: [...without, "stub-keep"] }) });
    assert.equal(on.status, 200);
    assert.ok(sinty.host.toolOwner("stub-keep.ping"));

    const removed = await app.request("/v1/plugins/stub-keep", { method: "DELETE", headers: auth });
    assert.equal(removed.status, 200);
    assert.equal(existsSync(join(home, "plugins", "stub-keep")), false);
    assert.equal(existsSync(join(home, "data", "stub-keep")), false);
    assert.doesNotMatch(readFileSync(sinty.paths.config, "utf8"), /keep-me/);
    assert.equal(sinty.host.toolOwner("stub-keep.ping"), undefined);
    assert.deepEqual(listAgents(sinty.paths)[0]?.plugins, []);
    assert.deepEqual(listAgents(sinty.paths)[0]?.excludedPlugins, []);
    const bundled = await app.request("/v1/plugins/ui-web", { method: "DELETE", headers: auth });
    assert.equal(bundled.status, 409);
  } finally {
    await sinty.stop();
    try { cleanup(); } catch { /* ignore */ }
  }
});