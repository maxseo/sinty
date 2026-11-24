import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { buildManagedCore } from '../../../scripts/build-managed-core.mjs';
import { packageHarness } from '../../../scripts/harness-package.mjs';
import { ManagedUpdater, bootstrapManagedInstall, bootstrapStoppedHome, createUpdaterServer, updaterPipe } from './manager.mjs';
test('real Sinty web owner API -> independent helper -> A/B actual app builds, failed C rollback, retained same-home handover', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'sinty-real-web-update-')), root = join(dir, 'managed'), home = join(dir, 'home'), keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), releases = [], artifacts = new Map();
    const expires = new Date(Date.now() + 3600000).toISOString();
    let sequence = 0;
    const bytes = kind => Buffer.from(JSON.stringify({ format: kind === 'plugins' ? 'sinty.plugins/1' : 'sinty.harness/1', sequence, expires, [kind === 'plugins' ? 'packages' : 'releases']: kind === 'plugins' ? [] : releases }));
    const feed = createServer((req, res) => { const u = req.url ?? ''; if (/^\/(?:harness-)?index\.json(?:\.sig)?$/.test(u)) {
        const b = bytes(u.startsWith('/harness') ? 'harness' : 'plugins');
        res.end(u.endsWith('.sig') ? sign(null, b, keys.privateKey) : b);
        return;
    } const file = artifacts.get(u); if (!file) {
        res.writeHead(404).end();
        return;
    } fs.createReadStream(file).pipe(res); });
    await new Promise(r => feed.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + feed.address().port;
    bootstrapManagedInstall(root, { home, publicKey, origin: origin + '/', testLoopback: true });
    const core = await import(new URL('../../../packages/core/.real-managed-checkpoint/sinty.js', import.meta.url).href), config = await import(new URL('../../../packages/core/.real-managed-checkpoint/config.js', import.meta.url).href), roster = await import(new URL('../../../packages/core/.real-managed-checkpoint/roster.js', import.meta.url).href), yaml = await import(new URL('../../../packages/core/node_modules/yaml/dist/index.js', import.meta.url).href);
    core.initHome(home);
    const cfg = { server: { host: '127.0.0.1', port: 0, ui: 'ui-web' }, plugins: { enabled: ['ui-web', 'retained-plugin'], disabled: config.DEFAULT_ON_PLUGINS, config: { 'retained-plugin': { fixture: 'preserve' } }, searchPaths: [] }, providers: {}, models: { routes: {}, fallback: [] }, updates: { enabled: true, indexUrl: origin + '/index.json', publicKey }, supervisor: { enabled: false } };
    fs.writeFileSync(join(home, 'config.yaml'), yaml.stringify(cfg));
    fs.mkdirSync(join(home, 'plugins/retained-plugin/public'), { recursive: true });
    fs.writeFileSync(join(home, 'plugins/retained-plugin/sinty.plugin.json'), JSON.stringify({ name: 'retained-plugin', version: '1.0.0', description: 'static test fixture', runtime: 'node', kinds: ['ui'], permissions: {}, editable: false, ui: { static: 'public' } }));
    fs.writeFileSync(join(home, 'plugins/retained-plugin/public/index.html'), 'retained static plugin');
    const seeded = new core.Sinty({ home }), token = seeded.secrets.get('api.token');
    seeded.agent.createSession({ title: 'retained actual chat' });
    roster.saveProject(seeded.paths, { name: 'retained actual project' });
    seeded.accounts.setup({ email: 'fixture@example.invalid', password: 'fixture-only-password-123', firstName: 'RetainedFixture' });
    await seeded.stop();
    fs.mkdirSync(join(home, 'data/unrelated'), { recursive: true });
    fs.writeFileSync(join(home, 'data/unrelated/keep'), 'retained plugin DATA');
    const configBefore = fs.readFileSync(join(home, 'config.yaml'), 'utf8'), manager = new ManagedUpdater(root, { healthTimeoutMs: 1800, drainTimeoutMs: 1000 }), ipc = createUpdaterServer(manager);
    await new Promise(r => ipc.listen(updaterPipe(root), r));
    let second, secondServer;
    async function endpoint(r = root) { return JSON.parse(fs.readFileSync(join(r, 'control/runtime-endpoint.json'), 'utf8')).url; }
    async function request(path, body, headers = {}, r = root) { return fetch((await endpoint(r)) + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    async function publish(version, healthFailure = false) { const out = join(dir, 'source-' + version), manifest = await buildManagedCore({ out, version, uiDir: join(process.cwd(), 'apps/web/.real-managed-ui-checkpoint'), healthFailure, testFeedOrigin: origin }), artifact = join(dir, version + '.tgz'), info = await packageHarness({ dir: out, out: artifact }), entry = { ...manifest, ...info, name: 'sinty', publisher: 'test-only', url: origin + '/artifacts/' + info.sha256 + '.tgz' }; releases.push(entry); sequence++; artifacts.set('/artifacts/' + info.sha256 + '.tgz', artifact); return { entry, artifact }; }
    async function verifiedState(version, entry, r = root) { const response = await request('/v1/managed/identity', undefined, {}, r); assert.equal(response.status, 200); const identity = await response.json(); assert.equal(identity.version, version); assert.equal(identity.applicationVersion, version); assert.equal(identity.sha256, entry.sha256); assert.equal(identity.buildHash, entry.appBuildHash); assert.equal((await fetch((await endpoint(r)) + '/ui/ui-web/')).status, 200); assert.equal(await (await fetch((await endpoint(r)) + '/ui/retained-plugin/')).text(), 'retained static plugin'); assert.match(JSON.stringify(await (await request('/v1/sessions', undefined, {}, r)).json()), /retained actual chat/); assert.equal(fs.readFileSync(join(home, 'config.yaml'), 'utf8'), configBefore); assert.equal(fs.readFileSync(join(home, 'data/unrelated/keep'), 'utf8'), 'retained plugin DATA'); assert.match(JSON.stringify(roster.listProjects({ data: join(home, "data") })), /retained actual project/); const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(join(home, 'accounts.db'), { readOnly: true }); try {
        assert.equal(db.prepare('SELECT email FROM users WHERE email=?').get('fixture@example.invalid').email, 'fixture@example.invalid');
    }
    finally {
        db.close();
    } }
    try {
        const a = await publish('0.0.1001+managed.test');
        const initial = bytes('harness');
        manager.acceptCatalog(initial, sign(null, initial, keys.privateKey));
        await manager.receiveArtifact(a.entry.sha256, fs.createReadStream(a.artifact));
        const first = await manager.review(a.entry.version);
        assert.equal((await manager.apply(first.reviewId, true)).updated, true);
        await verifiedState(a.entry.version, a.entry);
        const b = await publish('0.0.1002+managed.test');
        assert.notEqual(a.entry.appBuildHash, b.entry.appBuildHash);
        assert.equal((await fetch((await endpoint()) + '/v1/updates/managed')).status, 401);
        assert.equal((await request('/v1/updates/review', { version: b.entry.version }, { Origin: 'https://attacker.invalid' })).status, 403);
        const listing = await (await request('/v1/updates/check', {})).json();
        assert.equal(listing.configured, true, JSON.stringify(listing));
        assert.ok(listing.harness.find(x => x.version === b.entry.version)?.applySupported);
        for (const [candidate, expected, rollback] of [[b, b, false], [await publish('0.0.1003+managed.test', true), b, true]]) {
            const response = await request('/v1/updates/review', { version: candidate.entry.version });
            assert.equal(response.status, 200, await response.clone().text());
            const review = await response.json();
            assert.equal(review.sha256, candidate.entry.sha256);
            assert.match(review.changelog, /Isolated real Sinty test build/);
            assert.notEqual((await request('/v1/updates/apply', { reviewId: review.reviewId, confirm: false })).status, 202);
            const apply = await request('/v1/updates/apply', { reviewId: review.reviewId, confirm: true });
            assert.equal(apply.status, 202, await apply.clone().text());
            assert.equal((await apply.json()).accepted, true);
            const until = Date.now() + 15000;
            while (Date.now() < until && !['committed', 'rolled_back', 'blocked', 'failed'].includes(manager.status().operation?.state))
                await delay(50);
            assert.equal(manager.status().operation?.state, rollback ? 'rolled_back' : 'committed', JSON.stringify(manager.status()));
            await verifiedState(expected.entry.version, expected.entry);
        }
        const proof = await manager.retireForHandover(), root2 = join(dir, 'managed-handover');
        await assert.rejects(bootstrapStoppedHome(root2, { home, publicKey, origin: origin + '/', testLoopback: true }, {}), /proof/);
        await bootstrapStoppedHome(root2, { home, publicKey, origin: origin + '/', testLoopback: true }, proof);
        await assert.rejects(manager.recover(), /not_owned/);
        second = new ManagedUpdater(root2, { healthTimeoutMs: 3000 });
        secondServer = createUpdaterServer(second);
        await new Promise(r => secondServer.listen(updaterPipe(root2), r));
        const index = bytes('harness');
        second.acceptCatalog(index, sign(null, index, keys.privateKey));
        await second.receiveArtifact(b.entry.sha256, fs.createReadStream(b.artifact));
        const review = await second.review(b.entry.version);
        assert.equal((await second.apply(review.reviewId, true)).updated, true);
        await verifiedState(b.entry.version, b.entry, root2);
        assert.equal(second.config.home, home);
        assert.equal(manager.config.mode, 'retired');
        assert.ok(fs.readdirSync(join(root, 'backups')).some(n => n.startsWith('handover-')));
    }
    finally {
        try {
            await second?.stop();
        }
        catch { }
        try {
            await manager.stop();
        }
        catch { }
        if (secondServer)
            await new Promise(r => secondServer.close(r));
        await new Promise(r => ipc.close(r));
        feed.closeAllConnections();
        await new Promise(r => feed.close(r));
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
    }
});
