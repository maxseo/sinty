import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";
import { test } from "node:test";
import { stringify } from "yaml";
import { createApp } from "../api/server.js";
import { DEFAULT_ON_PLUGINS, loadConfig } from "../config.js";
import { Sinty } from "../sinty.js";
import { resolvePaths } from "../paths.js";
import { setPluginEnabledInConfig } from "../mcp-install.js";
import { removeHomePlugin, PluginInstallError } from "../plugin-install.js";
import { FIXTURES, tempHome } from "./helpers.js";

function harness() {
  const tmp = tempHome();
  const paths = resolvePaths(tmp.home);
  const config = loadConfig(paths);
  config.plugins = { enabled: [], disabled: [...DEFAULT_ON_PLUGINS], config: {}, searchPaths: [FIXTURES] };
  config.supervisor.enabled = false;
  writeFileSync(paths.config, stringify(config));
  const logs: string[] = [];
  const sinty = new Sinty({ home: tmp.home, log: (_level, msg) => { logs.push(msg); } });
  const app = createApp(sinty);
  const headers = { authorization: "Bearer " + sinty.secrets.get("api.token")!, "content-type": "application/json" };
  return { ...tmp, sinty, app, headers, logs };
}
function stub(home: string, name: string, command: string[]) {
  const dir = join(home, "plugins", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sinty.plugin.json"), JSON.stringify({ name, version: "0.1.0", description: "fixture", runtime: "mcp-stdio", kinds: ["tool"], permissions: { fs: { write: ["$DATA"] } }, command }));
  return dir;
}
async function until(check: () => boolean) {
  for (let n = 0; n < 100; n++) { if (check()) return; await wait(30); }
  assert.fail("fixture did not reach expected state");
}

test("MCP library: disabled installs remain visible, no process/readiness wait on two boots", async () => {
  const h = harness();
  const marker = join(h.home, "data", "off-mcp", "spawned");
  const dir = stub(h.home, "off-mcp", [process.execPath, "server.mjs", marker]);
  writeFileSync(join(dir, "server.mjs"), "import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],'spawned');process.exit(1);");
  setPluginEnabledInConfig(h.sinty.paths, "off-mcp", false);
  try {
    for (let i = 0; i < 2; i++) {
      const instance = new Sinty({ home: h.home });
      try {
        const started = await instance.start({ background: false });
        assert.deepEqual(started.failedPlugins, []);
        assert.equal(instance.host.plugins.has("off-mcp"), false);
        const app = createApp(instance);
        assert.equal((await app.request("/v1/plugins/installed")).status, 401);
        const res = await app.request("/v1/plugins/installed", { headers: h.headers });
        assert.equal(res.status, 200);
        const body = await res.json() as { plugins: { name: string; enabled: boolean; status: string; removable: boolean; command?: unknown }[] };
        const row = body.plugins.find(p => p.name === "off-mcp")!;
        assert.ok(row); assert.equal(row.enabled, false); assert.equal(row.status, "disabled"); assert.equal(row.removable, true);
        assert.equal(row.command, undefined);
      } finally { await instance.stop(); }
    }
    assert.equal(existsSync(marker), false);
  } finally { await h.sinty.stop(); h.cleanup(); }
});

test("MCP switch: auth, validated input, hot on/off, tools removed, persistence and models unchanged", async () => {
  const h = harness();
  stub(h.home, "switch-mcp", [process.execPath, join(FIXTURES, "mcp-echo", "server.mjs")]);
  const url = "/v1/plugins/switch-mcp/enabled";
  try {
    assert.equal((await h.app.request(url, { method: "PUT", body: JSON.stringify({ enabled: true }) })).status, 401);
    assert.equal((await h.app.request(url, { method: "PUT", headers: h.headers, body: JSON.stringify({ enabled: "false" }) })).status, 400);
    const models = JSON.stringify(loadConfig(h.sinty.paths).models);
    const on = await h.app.request(url, { method: "PUT", headers: h.headers, body: JSON.stringify({ enabled: true }) });
    assert.equal(on.status, 200); assert.equal((await on.json() as { startError?: string }).startError, undefined);
    assert.ok(h.sinty.host.toolOwner("switch-mcp.ping"));
    const off = await h.app.request(url, { method: "PUT", headers: h.headers, body: JSON.stringify({ enabled: false }) });
    assert.equal(off.status, 200);
    assert.equal(h.sinty.host.toolOwner("switch-mcp.ping"), undefined);
    assert.equal(h.sinty.host.plugins.has("switch-mcp"), false);
    assert.ok(loadConfig(h.sinty.paths).plugins.disabled?.includes("switch-mcp"));
    assert.equal(JSON.stringify(loadConfig(h.sinty.paths).models), models);
    const again = await h.app.request(url, { method: "PUT", headers: h.headers, body: JSON.stringify({ enabled: true }) });
    assert.equal(again.status, 200); assert.ok(h.sinty.host.toolOwner("switch-mcp.ping"));
  } finally { await h.sinty.stop(); h.cleanup(); }
});

test("disable during pending crash restart cancels timer/waiters and cannot resurrect tools", async () => {
  const h = harness();
  try {
    h.sinty.config.plugins.enabled.push("test-tools");
    assert.equal(await h.sinty.host.reload("test-tools"), undefined);
    const proc = h.sinty.host.plugins.get("test-tools")!;
    const internals = proc as unknown as { child: ChildProcess; restartTimer?: unknown; restarting?: Promise<void> };
    const exit = once(internals.child, "exit"); internals.child.kill(); await exit;
    assert.ok(internals.restartTimer);
    let starts = 0; proc.start = async () => { starts++; };
    const pending = internals.restarting!;
    h.sinty.config.plugins.enabled = [];
    await h.sinty.host.unload("test-tools");
    await pending;
    assert.equal(internals.restartTimer, undefined); assert.equal(internals.restarting, undefined);
    await wait(650);
    assert.equal(starts, 0); assert.equal(h.sinty.host.toolOwner("crash.now"), undefined);
    assert.equal(await h.sinty.host.reload("test-tools"), undefined);
    assert.equal(h.sinty.host.plugins.has("test-tools"), false);
  } finally { await h.sinty.stop(); h.cleanup(); }
});

test("failed MCP initial start is owned, stopped and never orphan-restarted", async () => {
  const h = harness();
  try {
    const marker = join(h.home, "data", "broken-mcp", "starts");
    const dir = stub(h.home, "broken-mcp", [process.execPath, "server.mjs", marker]);
    writeFileSync(join(dir, "server.mjs"), "import {appendFileSync} from 'node:fs';appendFileSync(process.argv[2],'start\\n');process.exit(1);");
    h.sinty.config.plugins.enabled.push("broken-mcp");
    const startError = await h.sinty.host.reload("broken-mcp");
    const result = { started: !startError, startError };
    assert.equal(result.started, false); assert.ok(result.startError);
    assert.equal(h.sinty.host.plugins.has("broken-mcp"), false);
    assert.ok(h.sinty.host.startErrors.has("broken-mcp"));
    await wait(650);
    assert.equal(h.sinty.host.plugins.has("broken-mcp"), false);
    assert.equal(readFileSync(marker, "utf8"), "start\n");
    const res = await h.app.request("/v1/plugins/installed", { headers: h.headers });
    const body = await res.json() as { plugins: { name: string; status: string; error?: string }[] };
    assert.equal(body.plugins.find(p => p.name === "broken-mcp")?.status, "failed");
  } finally { await h.sinty.stop(); h.cleanup(); }
});

test("disable while MCP initialize hangs closes both runner and server before readiness timeout", async () => {
  const h = harness(); const marker = join(h.home, "data", "pending-mcp", "server-pid");
  const dir = stub(h.home, "pending-mcp", [process.execPath, "server.mjs", marker]);
  writeFileSync(join(dir, "server.mjs"), "import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);");
  h.sinty.config.plugins.enabled.push("pending-mcp");
  try {
    const starting = h.sinty.host.reload("pending-mcp");
    await until(() => existsSync(marker)).catch(e => { throw new Error(String(e) + "\n" + h.logs.join("\n") + "\n" + [...h.sinty.host.startErrors.values()].join("\n")); });
    const pid = Number(readFileSync(marker, "utf8"));
    const off = await h.app.request("/v1/plugins/pending-mcp/enabled", { method: "PUT", headers: h.headers, body: JSON.stringify({ enabled: false }) });
    assert.equal(off.status, 200); await starting;
    assert.equal(h.sinty.host.plugins.has("pending-mcp"), false);
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  } finally { await h.sinty.stop(); h.cleanup(); }
});

test("uninstall preserves data, secrets and shared dependencies; disabled install disappears", async () => {
  const h = harness();
  const dir = stub(h.home, "remove-mcp", [process.execPath, "-e", "process.exit(0)"]);
  const data = join(h.home, "data", "remove-mcp"); mkdirSync(data, { recursive: true }); writeFileSync(join(data, "keep"), "keep");
  const shared = join(h.home, "plugins", "node_modules"); mkdirSync(shared, { recursive: true }); writeFileSync(join(shared, "keep"), "shared");
  symlinkSync(shared, join(dir, "shared-link"), process.platform === "win32" ? "junction" : "dir");
  h.sinty.secrets.set("remove-mcp.key", "fixture-secret"); setPluginEnabledInConfig(h.sinty.paths, "remove-mcp", false);
  try {
    await removeHomePlugin(h.sinty.paths, h.sinty.host, "remove-mcp");
    assert.equal(existsSync(dir), false); assert.equal(readFileSync(join(data, "keep"), "utf8"), "keep");
    assert.equal(readFileSync(join(shared, "keep"), "utf8"), "shared"); assert.equal(h.sinty.secrets.get("remove-mcp.key"), "fixture-secret");
    assert.equal(loadConfig(h.sinty.paths).plugins.disabled?.includes("remove-mcp"), false);
    const res = await h.app.request("/v1/plugins/installed", { headers: h.headers });
    assert.equal((await res.json() as { plugins: { name: string }[] }).plugins.some(p => p.name === "remove-mcp"), false);
  } finally { await h.sinty.stop(); h.cleanup(); }
});

test("uninstall refuses traversal, bundled, symlink/junction and external installations", async () => {
  const h = harness();
  const outside = join(h.home, "outside"); mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "sinty.plugin.json"), JSON.stringify({ name: "linked-mcp", version: "0.1.0", description: "fixture", runtime: "http", kinds: ["tool"], permissions: {}, url: "https://example.invalid" }));
  symlinkSync(outside, join(h.home, "plugins", "linked-mcp"), process.platform === "win32" ? "junction" : "dir");
  try {
    for (const [name, code] of [["../outside", "bad_name"], ["ui-web", "bundled"], ["linked-mcp", "unsafe_path"], ["test-tools", "not_found"]]) {
      await assert.rejects(() => removeHomePlugin(h.sinty.paths, h.sinty.host, name!), (e: unknown) => e instanceof PluginInstallError && e.code === code);
    }
    assert.ok(existsSync(join(outside, "sinty.plugin.json")));
    const ambiguous = stub(h.home, "test-tools", [process.execPath, "-e", "process.exit(0)"]);
    await assert.rejects(() => removeHomePlugin(h.sinty.paths, h.sinty.host, "test-tools"), (e: unknown) => e instanceof PluginInstallError && e.code === "external");
    assert.ok(existsSync(join(ambiguous, "sinty.plugin.json")));
  } finally { await h.sinty.stop(); h.cleanup(); }
});


test("newer unload cancels a reload waiting for an older process shutdown", async () => {
  const h = harness(); let release: (() => void) | undefined;
  try {
    h.sinty.config.plugins.enabled.push("test-tools");
    assert.equal(await h.sinty.host.reload("test-tools"), undefined);
    const old = h.sinty.host.plugins.get("test-tools")!;
    const stop = old.stopAndWait.bind(old);
    const gate = new Promise<void>(r => { release = r; });
    old.stopAndWait = async () => { await gate; await stop(); };
    const reloading = h.sinty.host.reload("test-tools");
    await h.sinty.host.unload("test-tools");
    release!(); await reloading;
    assert.equal(h.sinty.host.plugins.has("test-tools"), false);
  } finally { release?.(); await h.sinty.stop(); h.cleanup(); }
});

test("explicit off for a default-on bundled plugin survives config reload", async () => {
  const h = harness();
  try {
    const url = "/v1/plugins/mcp-catalog/enabled";
    for (const enabled of [true, false]) {
      const res = await h.app.request(url, { method: "PUT", headers: h.headers, body: JSON.stringify({ enabled }) });
      assert.equal(res.status, 200);
      assert.equal(Boolean(h.sinty.host.plugins.get("mcp-catalog")), enabled);
    }
    const fresh = loadConfig(h.sinty.paths);
    assert.equal(fresh.plugins.enabled.includes("mcp-catalog"), false);
    assert.ok(fresh.plugins.disabled?.includes("mcp-catalog"));
  } finally { await h.sinty.stop(); h.cleanup(); }
});


test("MCP lifecycle APIs enforce staff view/edit/delete permissions", async () => {
  const h = harness();
  stub(h.home, "access-mcp", [process.execPath, "-e", "process.exit(0)"]);
  try {
    h.sinty.accounts.setup({ email: "root@example.com", password: "fixture-password" });
    const role = h.sinty.accounts.createRole("Viewer");
    h.sinty.accounts.saveGrants(role.id, [{ resource: "nav:plugins", view: true, add: false, edit: false, delete: false }]);
    h.sinty.accounts.createUser({ email: "viewer@example.com", password: "fixture-password", roleId: role.id });
    const { token } = h.sinty.accounts.login("viewer@example.com", "fixture-password");
    const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
    assert.equal((await h.app.request("/v1/plugins/installed", { headers })).status, 200);
    assert.equal((await h.app.request("/v1/plugins/access-mcp/enabled", { method: "PUT", headers, body: JSON.stringify({ enabled: true }) })).status, 403);
    assert.equal((await h.app.request("/v1/plugins/access-mcp", { method: "DELETE", headers })).status, 403);
    assert.ok(existsSync(join(h.home, "plugins", "access-mcp", "sinty.plugin.json")));
  } finally { await h.sinty.stop(); h.cleanup(); }
});
