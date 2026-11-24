import {PluginMaintenanceGate} from "../plugin-maintenance.js";
import {linkSync} from "node:fs";
import { boot, tempHome } from "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transactPluginDirectory } from "../plugin-transaction.js";
import { installHomePlugin } from "../plugin-install.js";
import { releaseHash } from "../plugin-release.js";
import { resolvePaths } from "../paths.js";
import { loadConfig } from "../config.js";
import type { PluginHost } from "../host/host.js";
function files() { const root = mkdtempSync(join(tmpdir(), "plugin-tx-")), plugins = join(root, "plugins"), source = join(root, "source"), dest = join(plugins, "tx-plugin"); mkdirSync(dest, { recursive: true }); mkdirSync(source); writeFileSync(join(dest, "version"), "old"); writeFileSync(join(source, "version"), "new"); return { root, plugins, source, dest, done: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }) }; }
test("transaction stages validation first; invalid candidate never stops old runtime or deletes package", async () => { const f = files(); let stopped = 0; try {
    await assert.rejects(transactPluginDirectory({ root: f.plugins, name: "tx-plugin", source: f.source, validate() { throw Error("bad candidate"); }, stop: async () => { stopped++; }, activate: async () => { }, commit() { }, restoreRuntime: async () => { } }), /bad candidate/);
    assert.equal(stopped, 0);
    assert.equal(readFileSync(join(f.dest, "version"), "utf8"), "old");
}
finally {
    f.done();
} });
test("successful replacement retains previous package and activates before commit", async () => { const f = files(), order: string[] = []; try {
    const tx = await transactPluginDirectory({ root: f.plugins, name: "tx-plugin", source: f.source, validate() { order.push("validate"); }, stop: async () => { order.push("stop"); }, activate: async () => { order.push("activate"); return "ready"; }, commit() { order.push("commit"); }, restoreRuntime: async () => { } });
    assert.deepEqual(order, ["validate", "stop", "activate", "commit"]);
    assert.equal(readFileSync(join(tx.previous!, "version"), "utf8"), "old");
    assert.equal(readFileSync(join(f.dest, "version"), "utf8"), "new");
}
finally {
    f.done();
} });
test("readiness failure restores exact old package before restarting old runtime", async () => { const f = files(); let restored = false; try {
    await assert.rejects(transactPluginDirectory({ root: f.plugins, name: "tx-plugin", source: f.source, validate() { }, stop: async () => { }, activate: async () => { throw Error("new start failed"); }, commit() { throw Error("must not commit"); }, restoreRuntime: async () => { assert.equal(readFileSync(join(f.dest, "version"), "utf8"), "old"); restored = true; } }), { code: "activation_failed_rolled_back", rollbackRestored: true });
    assert.ok(restored);
}
finally {
    f.done();
} });
test("injected activation rename failure recovers old directory without deleting it", async () => { const f = files(); let failed = false; try {
    await assert.rejects(transactPluginDirectory({ root: f.plugins, name: "tx-plugin", source: f.source, validate() { }, stop: async () => { }, activate: async () => { }, commit() { }, restoreRuntime: async () => { }, rename(a, b) { if (!failed && a.includes(".staging") && b === f.dest) {
            failed = true;
            throw Error("synthetic EPERM");
        } renameSync(a, b); } }), { code: "activation_failed_rolled_back" });
    assert.equal(readFileSync(join(f.dest, "version"), "utf8"), "old");
}
finally {
    f.done();
} });
test("commit failure rolls package back; failed old restart reports rollback_failed honestly", async () => { const f = files(); try {
    await assert.rejects(transactPluginDirectory({ root: f.plugins, name: "tx-plugin", source: f.source, validate() { }, stop: async () => { }, activate: async () => { }, commit() { throw Error("disk full"); }, restoreRuntime: async () => { throw Error("old restart unavailable"); } }), { code: "rollback_failed", rollbackRestored: false });
    assert.equal(readFileSync(join(f.dest, "version"), "utf8"), "old");
}
finally {
    f.done();
} });
test("cross-instance install lock refuses a concurrent operation without stealing lock", async () => { const f = files(); try {
    mkdirSync(join(f.plugins, ".staging"));
    writeFileSync(join(f.plugins, ".staging/plugin-install.lock"), "owned by another fixture");
    await assert.rejects(transactPluginDirectory({ root: f.plugins, name: "tx-plugin", source: f.source, validate() { }, stop: async () => { }, activate: async () => { }, commit() { }, restoreRuntime: async () => { } }), { code: "install_busy" });
    assert.equal(readFileSync(join(f.dest, "version"), "utf8"), "old");
}
finally {
    f.done();
} });
function fixture() { const f = files(), paths = resolvePaths(f.root), old = { name: "tx-plugin", version: "1.0.0", description: "synthetic old", runtime: "node", kinds: ["tool"], entry: "index.js", permissions: {} }, next = { ...old, version: "1.1.0", description: "synthetic new" }; writeFileSync(join(f.dest, "sinty.plugin.json"), JSON.stringify(old)); writeFileSync(join(f.dest, "index.js"), "old"); writeFileSync(join(f.source, "sinty.plugin.json"), JSON.stringify(next)); writeFileSync(join(f.source, "index.js"), "new"); writeFileSync(paths.config, 'plugins:\n  enabled: [before, tx-plugin, after]\n  disabled: []\n  config:\n    tx-plugin:\n      keep: synthetic\n'); mkdirSync(join(paths.data, "tx-plugin"), { recursive: true }); writeFileSync(join(paths.data, "tx-plugin/user-state"), "synthetic-user-data"); const config = loadConfig(paths); config.plugins.enabled = ["before", "tx-plugin", "after"]; config.plugins.disabled = []; const plugins = new Map<string, unknown>([["tx-plugin", {}]]); let failNew = false, failOld = false; const gate=new PluginMaintenanceGate(); const host = { plugins, recoveryBlocked:new Map(), beginUpdate:(n:string)=>gate.acquire(n,()=>0), unload: async (n: string) => { plugins.delete(n); }, reload: async (n: string) => { plugins.delete(n); const v = JSON.parse(readFileSync(join(f.dest, "sinty.plugin.json"), "utf8")).version; if (v === "1.1.0" && failNew || v === "1.0.0" && failOld)
        return "synthetic failed readiness"; plugins.set(n, {}); return undefined; } } as unknown as PluginHost; return { ...f, paths, old, next, config, host, setFail: () => { failNew = true; }, setFailOld: () => { failOld = true; }, configBefore: readFileSync(paths.config, "utf8") }; }
test("installer integration failed update reload preserves config bytes/order data identity and restarts old plugin", async () => { const f = fixture(); try {
    f.setFail();
    await assert.rejects(installHomePlugin(f.paths, f.config, f.host, { path: f.source, replace: true }), { code: "activation_failed_rolled_back" });
    assert.equal(JSON.parse(readFileSync(join(f.dest, "sinty.plugin.json"), "utf8")).version, "1.0.0");
    assert.ok(f.host.plugins.has("tx-plugin"));
    assert.equal(readFileSync(f.paths.config, "utf8"), f.configBefore);
    assert.deepEqual(f.config.plugins.enabled, ["before", "tx-plugin", "after"]);
    assert.equal(readFileSync(join(f.paths.data, "tx-plugin/user-state"), "utf8"), "synthetic-user-data");
}
finally {
    f.done();
} });
test("installer requires exact permission-delta review before quiescing old runtime", async () => { const f = fixture(); try {
    const next = { ...f.next, permissions: { net: ["example.com"] } };
    writeFileSync(join(f.source, "sinty.plugin.json"), JSON.stringify(next));
    await assert.rejects(installHomePlugin(f.paths, f.config, f.host, { path: f.source, replace: true }), { code: "permission_review_required" });
    assert.ok(f.host.plugins.has("tx-plugin"));
    const result = await installHomePlugin(f.paths, f.config, f.host, { path: f.source, replace: true, permissionsReview: { from: releaseHash(f.old.permissions), to: releaseHash(next.permissions) } });
    assert.equal(result.started, true);
    assert.equal(readFileSync(join(f.paths.data, "tx-plugin/user-state"), "utf8"), "synthetic-user-data");
    assert.ok(readdirSync(join(f.plugins, ".rollback")).some(n => n.startsWith("tx-plugin-")));
}
finally {
    f.done();
} });
test("incompatible core/SDK blocks before any mutation or old unload", async () => { const f = fixture(); try {
    writeFileSync(join(f.source, "sinty.plugin.json"), JSON.stringify({ ...f.next, compatibility: { core: ">=99.0.0" } }));
    await assert.rejects(installHomePlugin(f.paths, f.config, f.host, { path: f.source, replace: true }), { code: "incompatible_plugin" });
    assert.ok(f.host.plugins.has("tx-plugin"));
    assert.equal(readFileSync(f.paths.config, "utf8"), f.configBefore);
}
finally {
    f.done();
} });
test("real sandbox plugin process: failed replacement restores prior running tool and unchanged config", async () => { const { home } = tempHome(); const sinty = await boot(home, [], { plugins: ["fake-provider"], config: { plugins: { disabled: ["tool-web", "tool-vision", "tool-stt", "skills", "mcp-catalog", "responsive-turn"] } } as never }); const source = join(home, "actual-source"); mkdirSync(source); const manifest = { name: "actual-rollback", version: "1.0.0", description: "synthetic actual old runtime", kinds: ["tool"], runtime: "node", entry: "index.js", permissions: {} }; try {
    writeFileSync(join(source, "sinty.plugin.json"), JSON.stringify(manifest));
    writeFileSync(join(source, "index.js"), 'import {definePlugin,z} from "@sinty/sdk";export default definePlugin({name:"actual-rollback",setup(ctx){ctx.tool({name:"actual-rollback.ping",description:"OLD-ACTUAL-RUNTIME",input:z.object({}),sideEffects:"none",run:async()=>({content:"synthetic old"})})}});');
    await installHomePlugin(sinty.paths, sinty.config, sinty.host, { path: source });
    const configBefore = readFileSync(sinty.paths.config, "utf8");
    writeFileSync(join(source, "sinty.plugin.json"), JSON.stringify({ ...manifest, version: "1.1.0" }));
    writeFileSync(join(source, "index.js"), 'throw new Error("synthetic invalid startup");export default {};');
    await assert.rejects(installHomePlugin(sinty.paths, sinty.config, sinty.host, { path: source, replace: true }), { code: "activation_failed_rolled_back" });
    assert.equal(sinty.host.tools().find(t => t.name === "actual-rollback.ping")?.description, "OLD-ACTUAL-RUNTIME");
    assert.equal(readFileSync(sinty.paths.config, "utf8"), configBefore);
    assert.equal(JSON.parse(readFileSync(join(sinty.paths.plugins, "actual-rollback/sinty.plugin.json"), "utf8")).version, "1.0.0");
}
finally {
    await sinty.stop();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
} });

test("declared missing changelog is rejected before old plugin unload",async()=>{const f=fixture();try{writeFileSync(join(f.source,"sinty.plugin.json"),JSON.stringify({...f.next,changelog:"CHANGELOG.md"}));await assert.rejects(installHomePlugin(f.paths,f.config,f.host,{path:f.source,replace:true}),{code:"bad_changelog"});assert.ok(f.host.plugins.has("tx-plugin"));assert.equal(readFileSync(f.paths.config,"utf8"),f.configBefore)}finally{f.done()}});
test("hardlinked materialized source is rejected without interrupting old runtime",async()=>{const f=fixture();try{linkSync(join(f.source,"index.js"),join(f.source,"second-hardlink.js"));await assert.rejects(installHomePlugin(f.paths,f.config,f.host,{path:f.source,replace:true}),{code:"unsafe_package"});assert.ok(f.host.plugins.has("tx-plugin"));assert.equal(readFileSync(f.paths.config,"utf8"),f.configBefore)}finally{f.done()}});
