import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PluginMaintenanceGate } from "../plugin-maintenance.js";
import { recoverPluginTransactions, readUpdateJournals, packageFingerprint, updateHistory, configPluginFlags } from "../plugin-recovery.js";
import { transactPluginDirectory } from "../plugin-transaction.js";
function fixture() { const root = mkdtempSync(join(tmpdir(), "sinty-recovery-")), plugins = join(root, "plugins"), data = join(root, "data"), source = join(root, "source"), dest = join(plugins, "recovery-test"), config = join(root, "config.yaml"); for (const d of [dest, source, join(data, "recovery-test")])
    mkdirSync(d, { recursive: true }); writeFileSync(join(dest, "version"), "old"); writeFileSync(join(source, "version"), "new"); writeFileSync(join(data, "recovery-test", "user-data"), "keep"); writeFileSync(config, "# retain owner comment\nplugins:\n  enabled: [other-plugin]\n  disabled: [recovery-test]\n  config:\n    other-plugin: {keep: true}\n"); return { root, plugins, data, source, dest, config, done() { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }); } }; }
function crash(f: ReturnType<typeof fixture>, phase: string, changed = false) {
    const code = [
        'import {transactPluginDirectory} from ' + JSON.stringify(new URL("../plugin-transaction.js", import.meta.url).href) + ';',
        'import {writeFileSync} from "node:fs";import {join} from "node:path";',
        'const f=' + JSON.stringify(f) + ';',
        'await transactPluginDirectory({root:f.plugins,name:"recovery-test",source:f.source,dataRoot:f.data,configPath:f.config,configBefore:{enabled:false,disabled:true},configAfter:{enabled:true,disabled:false},metadata:{version:"2.0.0",previousVersion:"1.0.0",source:"path",trust:"local-path-unverified",signatureVerified:false,publisher:null,changelog:"Synthetic v2"},validate(){},stop:async()=>{},activate:async()=>{' + (changed ? 'writeFileSync(join(f.data,"recovery-test","user-data"),"migration v2");' : '') + '},commit(){writeFileSync(f.config,"plugins:\\n  enabled: [other-plugin, recovery-test]\\n  disabled: []\\n  config:\\n    other-plugin: {keep: true}\\n");' + (phase === 'after_config' ? 'process.exit(71);' : '') + '},restoreRuntime:async()=>{},checkpoint(p){if(p===' + JSON.stringify(phase) + ')process.exit(71)}});'
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 71, result.stderr);
}
for (const phase of ["prepared", "old_move_intent", "new_move_intent", "activate_intent", "ready", "after_config"]) {
    test("real process exit recovery boundary: " + phase, () => { const f = fixture(); try {
        crash(f, phase);
        const r = recoverPluginTransactions(f.plugins, { dataRoot: f.data, configPath: f.config });
        assert.deepEqual(r.blocked, []);
        assert.deepEqual(r.repaired, ["recovery-test"]);
        assert.equal(readFileSync(join(f.dest, "version"), "utf8"), "old");
        assert.equal(readFileSync(join(f.data, "recovery-test", "user-data"), "utf8"), "keep");
        assert.deepEqual(configPluginFlags(f.config, "recovery-test"), { enabled: false, disabled: true });
        assert.deepEqual(recoverPluginTransactions(f.plugins, { dataRoot: f.data, configPath: f.config }).repaired, []);
        assert.equal(readUpdateJournals(f.plugins)[0]?.phase, "rolled_back");
    }
    finally {
        f.done();
    } });
}
test("committed replacement survives restart and records unsigned history honestly", () => { const f = fixture(); try {
    crash(f, "committed");
    assert.deepEqual(recoverPluginTransactions(f.plugins, { dataRoot: f.data, configPath: f.config }).repaired, []);
    assert.equal(readFileSync(join(f.dest, "version"), "utf8"), "new");
    const h = updateHistory(f.plugins) as {
        signatureVerified: boolean;
        version: string;
        changelog: string;
    }[];
    assert.equal(h[0]?.signatureVerified, false);
    assert.equal(h[0]?.version, "2.0.0");
    assert.equal(h[0]?.changelog, "Synthetic v2");
}
finally {
    f.done();
} });
test("changed plugin DATA blocks automatic downgrade without deleting old/new/data", () => { const f = fixture(); try {
    crash(f, "ready", true);
    const r = recoverPluginTransactions(f.plugins, { dataRoot: f.data, configPath: f.config });
    assert.deepEqual(r.blocked, [{ name: "recovery-test", reason: "data_review_required" }]);
    assert.equal(readFileSync(join(f.dest, "version"), "utf8"), "new");
    assert.equal(readFileSync(join(f.data, "recovery-test", "user-data"), "utf8"), "migration v2");
    const j = readUpdateJournals(f.plugins)[0]!;
    assert.ok(existsSync(join(f.plugins, ".rollback", j.name + "-" + j.id)));
    assert.equal(recoverPluginTransactions(f.plugins, { dataRoot: f.data, configPath: f.config }).blocked.length, 1);
}
finally {
    f.done();
} });
test("live owner and unknown legacy locks are never stolen", () => { const f = fixture(); try {
    mkdirSync(join(f.plugins, ".staging"));
    const lock = join(f.plugins, ".staging", "plugin-install.lock");
    writeFileSync(lock, JSON.stringify({ format: "sinty.plugin-lock/1", pid: process.pid, nonce: "11111111-1111-1111-1111-111111111111" }));
    assert.throws(() => recoverPluginTransactions(f.plugins, { dataRoot: f.data }), /owner_active/);
    assert.ok(existsSync(lock));
    writeFileSync(lock, "legacy fixture");
    assert.throws(() => recoverPluginTransactions(f.plugins, { dataRoot: f.data }), /legacy_install_lock_requires_review/);
    assert.equal(readFileSync(lock, "utf8"), "legacy fixture");
}
finally {
    f.done();
} });
test("changed candidate identity fails closed after interrupted activation", () => { const f = fixture(); try {
    crash(f, "activate_intent");
    writeFileSync(join(f.dest, "version"), "unreviewed");
    assert.equal(recoverPluginTransactions(f.plugins, { dataRoot: f.data }).blocked[0]?.reason, "package_identity_changed");
    assert.equal(readFileSync(join(f.dest, "version"), "utf8"), "unreviewed");
}
finally {
    f.done();
} });
test("fingerprint detects empty directories and hidden data names", () => { const f = fixture(); try {
    const a = packageFingerprint(f.data);
    mkdirSync(join(f.data, ".rollback"));
    assert.notEqual(packageFingerprint(f.data), a);
}
finally {
    f.done();
} });
test("maintenance waits for one plugin, blocks new entries, and releases on timeout", async () => { const g = new PluginMaintenanceGate(); let n = 1; const p = g.acquire("one", () => n, 1000); assert.equal(g.blocked("one"), true); assert.equal(g.blocked("other"), false); n = 0; const lease = await p; assert.equal(g.blocked("one", lease.token), false); await assert.rejects(g.acquire("one", () => 0), { code: "plugin_maintenance" }); lease.release(); await assert.rejects(g.acquire("one", () => 1, 0), { code: "plugin_busy" }); assert.equal(g.blocked("one"), false); });
test("caught activation failure with changed data refuses automatic old runtime restart", async () => { const f = fixture(); let restarted = false; try {
    await assert.rejects(transactPluginDirectory({ root: f.plugins, name: "recovery-test", source: f.source, dataRoot: f.data, validate() { }, stop: async () => { }, activate: async () => { writeFileSync(join(f.data, "recovery-test", "user-data"), "changed"); throw Error("synthetic failed setup"); }, commit() { }, restoreRuntime: async () => { restarted = true; } }), { code: "rollback_failed", rollbackRestored: false });
    assert.equal(restarted, false);
    assert.equal(readFileSync(join(f.dest, "version"), "utf8"), "new");
    assert.equal(readUpdateJournals(f.plugins)[0]?.phase, "recovery_required");
}
finally {
    f.done();
} });
import { boot, tempHome } from "./helpers.js";
import { installHomePlugin } from "../plugin-install.js";
import { createApp } from "../api/server.js";
const OFF = { plugins: { disabled: ["tool-web", "tool-browser", "tool-vision", "tool-stt", "skills", "mcp-catalog", "responsive-turn"] } } as never;
test("real host drains synthetic in-flight tool; new calls and reload cannot enter maintenance; history API is authenticated", async () => { const f = tempHome(), s = await boot(f.home, [], { plugins: ["fake-provider"], config: OFF }); const source = join(f.home, "source"), name = "drain-test"; mkdirSync(source); writeFileSync(join(source, "sinty.plugin.json"), JSON.stringify({ name, version: "1.0.0", description: "synthetic maintenance fixture", runtime: "node", entry: "index.js", kinds: ["tool"], permissions: {}, changelog: "CHANGELOG.md" })); writeFileSync(join(source, "CHANGELOG.md"), "# Synthetic release\nSafe history fixture"); writeFileSync(join(source, "index.js"), 'import {definePlugin,z} from "@sinty/sdk";export default definePlugin({name:"drain-test",setup(ctx){ctx.tool({name:"drain-test.wait",description:"synthetic delay",input:z.object({}),sideEffects:"none",run:async()=>{await new Promise(r=>setTimeout(r,150));return{content:"complete"}}})}})'); try {
    await installHomePlugin(s.paths, s.config, s.host, { path: source });
    const p = s.host.toolOwner("drain-test.wait")!, ctx = { sessionId: "synthetic-session", turnId: "synthetic-turn", callId: "synthetic-call", idempotencyKey: "synthetic-key" };
    const active = p.callTool("drain-test.wait", {}, ctx, {});
    const until = Date.now() + 1000;
    while (p.inFlight === 0 && Date.now() < until)
        await new Promise(r => setTimeout(r, 1));
    assert.ok(p.inFlight > 0);
    const waiting = s.host.beginUpdate(name, 1000);
    await assert.rejects(p.callTool("drain-test.wait", {}, ctx, {}), { code: "plugin_maintenance" });
    assert.equal(await s.host.reload(name), "plugin_maintenance");
    await assert.rejects(s.host.disable(name), { code: "plugin_maintenance" });
    assert.equal((await active).ok, true);
    const lease = await waiting;
    assert.equal(s.host.plugins.get(name), p);
    lease.release();
    assert.equal((await p.callTool("drain-test.wait", {}, ctx, {})).ok, true);
    const app = createApp(s);
    assert.equal((await app.request("/v1/plugins/history")).status, 401);
    const response = await app.request("/v1/plugins/history", { headers: { Authorization: "Bearer " + s.secrets.get("api.token")! } });
    assert.equal(response.status, 200);
    const body = await response.json() as {
        catalogConfigured: boolean;
        entries: {
            name: string;
            changelog: string;
            signatureVerified: boolean;
        }[];
    };
    assert.equal(body.catalogConfigured, false);
    const row = body.entries.find(e => e.name === name)!;
    assert.match(row.changelog, /Safe history fixture/);
    assert.equal(row.signatureVerified, false);
}
finally {
    await s.stop();
    f.cleanup();
} });
