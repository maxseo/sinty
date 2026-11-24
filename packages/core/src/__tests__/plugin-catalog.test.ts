import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { boot, tempHome } from "./helpers.js";
import { createApp } from "../api/server.js";
import { PluginCatalogClient } from "../plugin-catalog.js";
import { updateHistory } from "../plugin-recovery.js";
async function stopFully(s: Awaited<ReturnType<typeof boot>>) { const ps = [...s.host.plugins.values()]; await s.stop(); await Promise.all(ps.map(p => p.stopAndWait())); }
const OFF = ["tool-web", "tool-browser", "tool-vision", "tool-stt", "skills", "mcp-catalog", "responsive-turn"];
test("signed catalog real API E2E: CLI publish, install v1, permission-reviewed update v2, tamper rejection, failed activation rollback, restart", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "catalog-e2e-")), source = join(scratch, "source"), out = join(scratch, "store"), key = join(scratch, "ephemeral-signing.pem"), home = tempHome();
    mkdirSync(source);
    mkdirSync(out);
    const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    writeFileSync(key, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
    const server = createServer((req, res) => { const n = req.url?.slice(1); if (!n || !/^[A-Za-z0-9_.-]+$/.test(n)) {
        res.writeHead(404).end();
        return;
    } try {
        res.writeHead(200).end(readFileSync(join(out, n)));
    }
    catch {
        res.writeHead(404).end();
    } });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    server.unref();
    const origin = "http://127.0.0.1:" + (server.address() as {
        port: number;
    }).port, options = { plugins: ["fake-provider", "plugin-catalog"], config: { plugins: { disabled: OFF, config: { "plugin-catalog": { indexUrl: origin + "/index.json", publicKey } } } } as never };
    let s = await boot(home.home, [], options);
    const publisherFile = fileURLToPath(new URL("../../../../scripts/plugin-publish.mjs", import.meta.url)), module = await import(new URL("../../../../scripts/plugin-publish.mjs", import.meta.url).href), env = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    function prepare(version: string, fail = false, extra = false) { writeFileSync(join(source, "package.json"), JSON.stringify({ name: "catalog-fixture", version, type: "module" })); writeFileSync(join(source, "sinty.plugin.json"), JSON.stringify({ name: "catalog-fixture", version, description: "synthetic signed catalog fixture", kinds: ["tool"], runtime: "node", entry: "index.js", updateMode: "rpc-only", changelog: "CHANGELOG.md", permissions: extra ? { fs: { read: ["$DATA"] } } : {} })); writeFileSync(join(source, "CHANGELOG.md"), "# " + version + "\nActual fixture changes"); writeFileSync(join(source, "index.js"), fail ? 'import {definePlugin} from "@sinty/sdk";export default definePlugin({name:"catalog-fixture",setup(){throw Error("synthetic readiness failure")}});' : 'import {definePlugin,z} from "@sinty/sdk";export default definePlugin({name:"catalog-fixture",setup(ctx){ctx.tool({name:"catalog-fixture.ping",description:' + JSON.stringify(version) + ',input:z.object({}),sideEffects:"none",run:async()=>({content:"ok"})})}});'); }
    const publish = () => module.publishPlugin({ dir: source, out, base: origin + "/", key, publisher: "fixture-owner", files: ["index.js", "CHANGELOG.md"] });
    const app = createApp(s, { catalogLoopbackOrigin: origin }), auth = { Authorization: "Bearer " + s.secrets.get("api.token")!, "Content-Type": "application/json" };
    const post = async (path: string, body: unknown) => app.request(path, { method: "POST", headers: auth, body: JSON.stringify(body) });
    const review = async (version: string) => { const r = await post("/v1/plugins/catalog/review", { name: "catalog-fixture", version }); assert.equal(r.status, 200, await r.clone().text()); return r.json() as Promise<{
        reviewId: string;
        permissionsChanged: boolean;
        compatible: boolean;
    }>; };
    try {
        prepare("1.0.0");
        execFileSync(process.execPath, [publisherFile, "--dir", source, "--out", out, "--base", origin + "/", "--key", key, "--publisher", "fixture-owner", "--files", "index.js,CHANGELOG.md"], { env: { ...process.env, NODE_ENV: "test" }, stdio: "pipe" });
        assert.equal((await app.request("/v1/plugins/catalog")).status, 401);
        const csrf = await app.request("/v1/plugins/catalog/review", { method: "POST", headers: { ...auth, Origin: "https://attacker.invalid" }, body: JSON.stringify({ name: "catalog-fixture", version: "1.0.0" }) });
        assert.equal(csrf.status, 403);
        assert.equal((await app.request("/v1/settings/sections/plugin.plugin-catalog", { method: "PUT", headers: { ...auth, Origin: "https://attacker.invalid" }, body: JSON.stringify({ values: { indexUrl: origin + "/index.json", publicKey } }) })).status, 403);
        const metadata = await (await app.request("/v1/plugins", { headers: auth })).json() as {
            plugins: {
                name: string;
                tabs?: {
                    placement: string;
                }[];
            }[];
        };
        assert.ok(metadata.plugins.find(p => p.name === "plugin-catalog")?.tabs?.some(t => t.placement === "plugins"));
        const v1 = await review("1.0.0");
        assert.equal(v1.compatible, true);
        const installed = await post("/v1/plugins/catalog/install", { reviewId: v1.reviewId, confirm: true });
        assert.equal(installed.status, 201, await installed.clone().text());
        const installedResult=await installed.json() as {trust:string;next:string};assert.equal(installedResult.trust,"trusted-catalog");assert.match(installedResult.next,/подписанного каталога/);
        mkdirSync(join(s.paths.data, "catalog-fixture"), { recursive: true });
        writeFileSync(join(s.paths.data, "catalog-fixture", "keep"), "synthetic retained data");
        prepare("2.0.0", false, true);
        publish();
        const v2 = await review("2.0.0");
        assert.equal(v2.permissionsChanged, true);
        assert.notEqual((await post("/v1/plugins/catalog/install", { reviewId: v2.reviewId, confirm: false })).status, 201);
        assert.equal(s.host.tools().find(t => t.name === "catalog-fixture.ping")?.description, "1.0.0");
        const updated = await post("/v1/plugins/catalog/install", { reviewId: v2.reviewId, confirm: true });
        assert.equal(updated.status, 201, await updated.clone().text());
        prepare("3.0.0", false, true);
        const v3 = publish(), artifact = join(out, new URL(v3.url).pathname.split('/').pop()!), original = readFileSync(artifact), tampered = Buffer.from(original);
        tampered[10] = tampered[10]! ^ 1;
        writeFileSync(artifact, tampered);
        assert.equal((await post("/v1/plugins/catalog/review", { name: "catalog-fixture", version: "3.0.0" })).status, 409);
        writeFileSync(artifact, original);
        prepare("3.0.0", true, true);
        assert.throws(publish, /Immutable version/);
        const configBeforeFailedUpdate=readFileSync(s.paths.config,"utf8");
        prepare("4.0.0", true, true);
        publish();
        const v4 = await review("4.0.0"), failed = await post("/v1/plugins/catalog/install", { reviewId: v4.reviewId, confirm: true });
        assert.equal(failed.status, 409);
        assert.match(await failed.text(), /activation_failed_rolled_back/);
        assert.equal(readFileSync(s.paths.config,"utf8"),configBeforeFailedUpdate);
        assert.equal(s.host.tools().find(t => t.name === "catalog-fixture.ping")?.description, "2.0.0");
        assert.equal(readFileSync(join(s.paths.data, "catalog-fixture", "keep"), "utf8"), "synthetic retained data");
        prepare("5.0.0", false, true);
        const restartManifest = JSON.parse(readFileSync(join(source, "sinty.plugin.json"), "utf8"));
        delete restartManifest.updateMode;
        writeFileSync(join(source, "sinty.plugin.json"), JSON.stringify(restartManifest));
        publish();
        const rr = await review("5.0.0") as unknown as {
            reviewId: string;
            restartRequired: boolean;
        };
        assert.equal(rr.restartRequired, true);
        const refused = await post("/v1/plugins/catalog/install", { reviewId: rr.reviewId, confirm: true });
        assert.equal(refused.status, 409);
        assert.match(await refused.text(), /plugin_restart_required/);
        assert.equal(s.host.tools().find(t => t.name === "catalog-fixture.ping")?.description, "2.0.0");
        prepare("6.0.0",false,true);publish();const installedManifestFile=join(s.paths.plugins,"catalog-fixture","sinty.plugin.json"),installedManifestBytes=readFileSync(installedManifestFile),unknownMode=JSON.parse(installedManifestBytes.toString("utf8"));delete unknownMode.updateMode;writeFileSync(installedManifestFile,JSON.stringify(unknownMode));const unsafeOld=await review("6.0.0") as unknown as {reviewId:string;restartRequired:boolean};assert.equal(unsafeOld.restartRequired,true);assert.equal((await post("/v1/plugins/catalog/install",{reviewId:unsafeOld.reviewId,confirm:true})).status,409);assert.equal(await s.host.reload("catalog-fixture"),undefined);writeFileSync(installedManifestFile,installedManifestBytes);const unknownRunning=await review("6.0.0") as unknown as {reviewId:string;restartRequired:boolean};assert.equal(unknownRunning.restartRequired,true);assert.equal((await post("/v1/plugins/catalog/install",{reviewId:unknownRunning.reviewId,confirm:true})).status,409);
        const history = updateHistory(s.paths.plugins) as {
            source: string;
            signatureVerified: boolean;
            phase: string;
            version: string;
        }[];
        assert.ok(history.some(h => h.version === "2.0.0" && h.phase === "committed" && h.signatureVerified && h.source === "catalog"));
        assert.ok(history.some(h => h.version === "4.0.0" && h.phase === "rolled_back"));
        await stopFully(s);
        s = await boot(home.home, [], { ...options, plugins: ["fake-provider", "plugin-catalog", "catalog-fixture"] });
        assert.equal(s.host.tools().find(t => t.name === "catalog-fixture.ping")?.description, "2.0.0");
        assert.equal(readFileSync(join(s.paths.data, "catalog-fixture", "keep"), "utf8"), "synthetic retained data");
    }
    catch (e) {
        console.error("SYNTHETIC E2E FAILED", e);
        throw e;
    }
    finally {
        if (env === undefined)
            delete process.env.NODE_ENV;
        else
            process.env.NODE_ENV = env;
        await stopFully(s);
        server.closeAllConnections();
        await new Promise<void>(r => server.close(() => r()));
        rmSync(home.home, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
        rmSync(scratch, { recursive: true, force: true });
    }
});
test("catalog unset is honest; production private HTTP is denied", async () => { const f = tempHome(), s = await boot(f.home, [], { plugins: ["fake-provider"], config: { plugins: { disabled: OFF } } as never }); try {
    assert.deepEqual(await new PluginCatalogClient(s.paths, s.config, s.host).list(), { configured: false, packages: [] });
    s.config.plugins.config["plugin-catalog"] = { indexUrl: "http://127.0.0.1:1/index.json", publicKey: "not-a-key" };
    await assert.rejects(new PluginCatalogClient(s.paths, s.config, s.host).list(), /https_required/);
    s.config.plugins.config["plugin-catalog"] = { indexUrl: "https://127.0.0.1:1/index.json", publicKey: "not-a-key" };
    await assert.rejects(new PluginCatalogClient(s.paths, s.config, s.host).list(), /private|blocked|loopback/);
}
finally {
    await stopFully(s);
    f.cleanup();
} });
import { Sinty } from "../sinty.js";
import { testConfig } from "./helpers.js";
test("corrupt global journal keeps authenticated core UI healthy, suspends work, preserves evidence; owner retry cannot steal/delete it", async () => { const f = tempHome(), tx = join(f.home, "plugins", ".staging", "transactions"), bad = join(tx, "11111111-1111-1111-1111-111111111111.json"); mkdirSync(tx, { recursive: true }); writeFileSync(bad, "{corrupt evidence"); const config = testConfig([], { plugins: { enabled: ["ui-web", "fake-provider"], disabled: OFF, config: {}, searchPaths: [] } } as never); let s = new Sinty({ home: f.home, config }); try {
    const result = await s.start();
    assert.ok(s.pluginRecoveryIssue);
    assert.deepEqual(result.resumedTurns, []);
    assert.equal(s.host.plugins.has("fake-provider"), false);
    assert.equal(s.host.plugins.has("ui-web"), true);
    const app = createApp(s), auth = { Authorization: "Bearer " + s.secrets.get("api.token")!, "Content-Type": "application/json" };
    assert.equal((await app.request("/v1/health")).status, 200);
    assert.equal((await app.request("/v1/plugins/recovery")).status, 401);
    assert.equal((await app.request("/v1/plugins/recovery", { headers: auth })).status, 200);
    assert.equal((await app.request("/v1/plugins/install", { method: "POST", headers: auth, body: "{}" })).status, 503);
    assert.equal((await app.request("/v1/plugins/recovery/retry", { method: "POST", headers: { ...auth, Origin: "https://attacker.invalid" }, body: '{"confirm":true}' })).status, 403);
    assert.equal((await app.request("/v1/plugins/recovery/retry", { method: "POST", headers: auth, body: '{"confirm":true}' })).status, 409);
    assert.equal(readFileSync(bad, "utf8"), "{corrupt evidence");
    rmSync(bad);
    const fixed = await app.request("/v1/plugins/recovery/retry", { method: "POST", headers: auth, body: '{"confirm":true}' });
    assert.equal(fixed.status, 200);
    assert.equal((await fixed.json() as {
        restartRequired: boolean;
    }).restartRequired, true);
    assert.equal(s.host.plugins.has("fake-provider"), false);
}
finally {
    await stopFully(s);
    rmSync(f.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
} });
