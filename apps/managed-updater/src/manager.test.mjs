import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { bootstrapManagedInstall, ManagedUpdater, runtimeRequest, updaterPipe } from './manager.mjs';
import { packageHarness } from '../../../scripts/harness-package.mjs';
async function fixture() { const dir = fs.mkdtempSync(join(tmpdir(), 'sinty-managed-test-')), root = join(dir, 'install'), home = join(dir, 'home'), keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(); bootstrapManagedInstall(root, { home, publicKey, origin: 'https://fixture.invalid/', dataSchema: 'fixture-v1' }); fs.writeFileSync(join(home, 'config.yaml'), 'fixture config'); fs.writeFileSync(join(home, 'secrets.json'), 'DO NOT READ OR LOG synthetic secret'); fs.mkdirSync(join(home, 'data', 'unrelated-plugin'), { recursive: true }); fs.writeFileSync(join(home, 'data', 'unrelated-plugin', 'keep'), 'retained data'); const releases = [], manager = new ManagedUpdater(root, { healthTimeoutMs: 500, drainTimeoutMs: 300 }); async function release(version, { fail = false, mutate = false, migrate = false } = {}) { const source = join(dir, 'source-' + version); fs.mkdirSync(join(source, 'app'), { recursive: true }); const manifest = { version, platform: process.platform, arch: process.arch, channel: 'stable', coreVersion: '0.1.0', sdkVersion: '0.1.0', updaterProtocol: 1, nodeRange: '>=24.0.0', dataSchema: 'fixture-v1', dataCompatibility: 'unchanged', migrations: 'none', changelog: 'CHANGELOG.md' }; fs.writeFileSync(join(source, 'release.json'), JSON.stringify(manifest)); fs.writeFileSync(join(source, 'CHANGELOG.md'), 'Real synthetic version ' + version); fs.writeFileSync(join(source, 'app', 'managed-main.mjs'), `import http from 'node:http';import fs from 'node:fs';import {join} from 'node:path';import {setTimeout as delay} from 'node:timers/promises';export async function startManaged({home,gate}){${mutate ? "fs.writeFileSync(join(home,'data','unrelated-plugin','keep'),'changed candidate data');" : ''}${migrate ? "const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(home,'journal.db'));db.exec('ALTER TABLE keep ADD COLUMN newer TEXT;PRAGMA user_version=2');db.close();" : ''}const server=http.createServer(async(req,res)=>{let leave;try{leave=gate.enter();if(req.url==='/work')await delay(220);res.end(${JSON.stringify(version)})}catch{res.statusCode=503;res.end('draining')}finally{leave?.()}});await new Promise(r=>server.listen(0,'127.0.0.1',r));fs.writeFileSync(join(home,'fixture-port'),String(server.address().port));return{health:async()=>${!fail},stop:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r))}}}`); const artifact = join(dir, version + '.tgz'), info = await packageHarness({ dir: source, out: artifact }), entry = { ...manifest, name: 'sinty', publisher: 'syntoffice', url: 'https://fixture.invalid/artifacts/' + info.sha256 + '.tgz', ...info }; releases.push(entry); const index = Buffer.from(JSON.stringify({ format: 'sinty.harness/1', sequence: releases.length, expires: new Date(Date.now() + 3600000).toISOString(), releases })); manager.acceptCatalog(index, sign(null, index, keys.privateKey)); await manager.receiveArtifact(entry.sha256, fs.createReadStream(artifact)); return { entry, index, signature: sign(null, index, keys.privateKey), artifact, manifest }; } return { dir, root, home, manager, release, keys, releases, async close() { try {
        await manager.stop();
    }
    catch { } fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); } }; }
async function install(f, version) { const r = await f.manager.review(version); return f.manager.apply(r.reviewId, true); }
test('Windows managed real Node runtime: signed installv1 -> updatev2 drains instance work -> failingv3 rollback retains data/config/secrets/unrelated plugin', async () => { const f = await fixture(); try {
    await f.release('1.0.0');
    assert.equal((await install(f, '1.0.0')).updated, true);
    const port = fs.readFileSync(join(f.home, 'fixture-port'), 'utf8');
    assert.equal(await (await fetch('http://127.0.0.1:' + port)).text(), '1.0.0');
    const v2 = await f.release('2.0.0'), review = await f.manager.review('2.0.0');
    assert.match(review.changelog, /2.0.0/);
    await assert.rejects(f.manager.apply(review.reviewId, false), /confirmation/);
    const work = fetch('http://127.0.0.1:' + port + '/work').then(r => r.text());
    await delay(35);
    const start = Date.now(), updated = await f.manager.apply(review.reviewId, true);
    assert.equal(updated.updated, true);
    assert.equal(await work, '1.0.0');
    assert.ok(Date.now() - start >= 150);
    const now = fs.readFileSync(join(f.home, 'fixture-port'), 'utf8');
    assert.equal(await (await fetch('http://127.0.0.1:' + now)).text(), '2.0.0');
    await f.release('3.0.0', { fail: true });
    const failed = await install(f, '3.0.0');
    assert.equal(failed.rolledBack, true);
    assert.equal(failed.version, '2.0.0');
    assert.equal(fs.readFileSync(join(f.home, 'config.yaml'), 'utf8'), 'fixture config');
    assert.equal(fs.readFileSync(join(f.home, 'data', 'unrelated-plugin', 'keep'), 'utf8'), 'retained data');
    assert.equal(fs.readFileSync(join(f.home, 'secrets.json'), 'utf8'), 'DO NOT READ OR LOG synthetic secret');
    assert.equal(f.manager.status().current, '2.0.0');
    assert.ok(fs.readdirSync(join(f.root, 'versions')).length === 3);
    await assert.rejects(f.manager.review('1.0.0'), /downgrade/);
}
finally {
    await f.close();
} });
test('signed release tamper, data migration, command injection, wrong platform/node and developer checkout fail closed before stopping old runtime', async () => { const f = await fixture(); try {
    const v1 = await f.release('1.0.0');
    const tampered = Buffer.from(v1.index);
    tampered[20] ^= 1;
    assert.throws(() => f.manager.acceptCatalog(tampered, v1.signature), /signature/);
    await install(f, '1.0.0');
    const v2 = await f.release('2.0.0');
    const bytes = fs.readFileSync(v2.artifact);
    bytes[20] ^= 1;
    await assert.rejects(f.manager.receiveArtifact(v2.entry.sha256, Readable.from([bytes])), /hash/);
    assert.equal(f.manager.status().current, '1.0.0');
    const cfg = f.manager.config;
    cfg.mode = 'development';
    await assert.rejects(f.manager.review('2.0.0'), /development/);
    cfg.mode = 'managed';
    const base = v2.manifest;assert.throws(()=>f.manager.validateManifest({...base,compatibility:{core:">=99.0.0"}},v2.entry),/incompatible/);
    for (const patch of [{ migrations: 'run-anything' }, { dataSchema: 'v2' }, { dataCompatibility: 'forward-only' }, { nodeRange: '>=99.0.0' }, { command: 'cmd.exe' }, { updaterProtocol: 2 }])
        assert.throws(() => f.manager.validateManifest({ ...base, ...patch }, v2.entry));
    assert.equal((await f.manager.probe(f.manager.current())).ready, true);
    fs.writeFileSync(join(f.root, 'control', 'journal.json'), 'broken JSON');
    assert.throws(() => f.manager.journal(), /invalid_update_journal/);
    assert.equal((await f.manager.probe(f.manager.current())).ready, true);
}
finally {
    await f.close();
} });
test('candidate DATA mutation blocks automatic downgrade and preserves changed data plus both packages', async () => { const f = await fixture(); try {
    await f.release('1.0.0');
    await install(f, '1.0.0');
    await f.release('2.0.0', { fail: true, mutate: true });
    const result = await install(f, '2.0.0');
    assert.equal(result.blocked, true);
    assert.match(result.error, /data_changed/);
    assert.equal(fs.readFileSync(join(f.home, 'data', 'unrelated-plugin', 'keep'), 'utf8'), 'changed candidate data');
    assert.equal(fs.readdirSync(join(f.root, 'versions')).length, 2);
}
finally {
    await f.close();
} });
for (const boundary of ['prepared', 'stop_intent', 'old_stopped', 'launch_intent', 'healthy', 'pointer_written', 'committed'])
    test('real updater process death recovery boundary: ' + boundary, async () => { const f = await fixture(); let child; try {
        await f.release('1.0.0');
        await install(f, '1.0.0');
        await f.release('2.0.0');
        const managerFile = new URL('./manager.mjs', import.meta.url).href, code = `import fs from 'node:fs';import {ManagedUpdater} from ${JSON.stringify(managerFile)};const m=new ManagedUpdater(process.argv[1],{healthTimeoutMs:1000,crashAt:process.argv[2]});const r=await m.review('2.0.0');await m.apply(r.reviewId,true);`;
        child = fork(new URL('./crash-fixture.mjs', import.meta.url), [f.root, boundary], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => { try {
            assert.equal(code, 77);
            resolve();
        }
        catch (e) {
            reject(e);
        } }); });
        const recovered = await f.manager.recover();
        assert.equal(f.manager.status().current, boundary === 'committed' ? '2.0.0' : '1.0.0');
        assert.equal((await f.manager.probe(f.manager.current())).ready, true);
        assert.equal(fs.readFileSync(join(f.home, 'data', 'unrelated-plugin', 'keep'), 'utf8'), 'retained data');
        assert.ok(fs.readdirSync(join(f.root, 'versions')).length === 2);
        assert.ok(fs.readdirSync(join(f.root, 'control')).some(n => n.includes('.abandoned.')));
    }
    finally {
        if (child && child.exitCode === null)
            child.kill();
        await f.close();
    } });
import http from 'node:http';
test('external updater IPC requires independent owner token, never exposes nonce, rejects arbitrary actions and unknown lock', async () => { const f = await fixture(), server = (await import('./manager.mjs')).createUpdaterServer(f.manager); try {
    await new Promise(r => server.listen(updaterPipe(f.root), r));
    const req = (route, token) => new Promise((resolve, reject) => { const r = http.request({ socketPath: updaterPipe(f.root), path: route, headers: token ? { Authorization: 'Bearer ' + token } : {} }, res => { let b = ''; res.on('data', x => b += x); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); r.on('error', reject); r.end(); });
    assert.equal((await req('/status')).status, 401);
    const status = await req('/status', f.manager.token);
    assert.equal(status.status, 200);
    assert.ok(!status.body.includes(f.manager.token));
    assert.equal((await req('/execute-cmd', f.manager.token)).status, 409);
    fs.writeFileSync(join(f.root, 'control', 'operation.lock'), '{}');
    await assert.rejects(f.manager.lock(async () => { }), /owned_or_unknown/);
    assert.equal(fs.readFileSync(join(f.root, 'control', 'operation.lock'), 'utf8'), '{}');
}
finally {
    await new Promise(r => server.close(r));
    await f.close();
} });
test('uncertain spawn crash gap stays blocked rather than launching duplicate runtimes', async () => { const f = await fixture(); try {
    await f.release('1.0.0');
    await install(f, '1.0.0');
    await f.release('2.0.0');
    const child = fork(new URL('./crash-fixture.mjs', import.meta.url), [f.root, 'spawn_pending'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise(r => child.once('exit', r));
    const result = await f.manager.recover();
    assert.equal(result.blocked, true);
    assert.match(result.error, /launch_unconfirmed/);
    assert.equal(fs.readFileSync(join(f.home, 'data', 'unrelated-plugin', 'keep'), 'utf8'), 'retained data');
}
finally {
    await f.close();
} });
test('built standalone updater installs verified runtime without source-module dependencies', async () => { const f = await fixture(); let built; try {
    await f.release('1.0.0');
    const module = await import(new URL('../dist/src/manager.mjs', import.meta.url).href);
    built = new module.ManagedUpdater(f.root, { healthTimeoutMs: 2000 });
    const review = await built.review('1.0.0');
    assert.equal((await built.apply(review.reviewId, true)).updated, true);
    assert.equal((await built.probe(built.current())).ready, true);
}
finally {
    if (built)
        await built.stop();
    await f.close();
} });
test('busy drain timeout preserves the same owned runtime; retry reuses intact immutable candidate', async () => { const f = await fixture(); try {
    await f.release('1.0.0');
    await install(f, '1.0.0');
    const old = f.manager.current(), port = fs.readFileSync(join(f.home, 'fixture-port'), 'utf8');
    await f.release('2.0.0');
    f.manager.drainTimeoutMs = 50;
    const work = fetch('http://127.0.0.1:' + port + '/work').then(r => r.text());
    await delay(30);
    const rejected = await install(f, '2.0.0');
    assert.equal(rejected.rolledBack, true);
    assert.equal(f.manager.current().pid, old.pid);
    assert.equal(await work, '1.0.0');
    f.manager.drainTimeoutMs = 300;
    assert.equal((await install(f, '2.0.0')).updated, true);
}
finally {
    await f.close();
} });
test('closed SQLite snapshots retain rows; undeclared schema change blocks downgrade without restoring over newer DB', async () => { const f = await fixture(); try {
    const { DatabaseSync } = await import('node:sqlite');
    let db = new DatabaseSync(join(f.home, 'journal.db'));
    db.exec("PRAGMA journal_mode=WAL;CREATE TABLE keep(value TEXT);INSERT INTO keep VALUES('retained row');PRAGMA user_version=1");
    db.close();
    await f.release('1.0.0');
    await install(f, '1.0.0');
    const backups = fs.readdirSync(join(f.root, 'backups'));
    assert.ok(backups.length);
    db = new DatabaseSync(join(f.root, 'backups', backups[0], 'journal.db'), { readOnly: true });
    assert.equal(db.prepare('SELECT value FROM keep').get().value, 'retained row');
    db.close();
    await f.release('2.0.0', { fail: true });
    const snapshot = await f.manager.review('2.0.0');
    const result = await f.manager.apply(snapshot.reviewId, true);
    assert.equal(result.rolledBack, true);
    db = new DatabaseSync(join(f.home, 'journal.db'), { readOnly: true });
    assert.equal(db.prepare('SELECT value FROM keep').get().value, 'retained row');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    db.close();
    await f.release('3.0.0', { fail: true, migrate: true });
    const blocked = await install(f, '3.0.0');
    assert.equal(blocked.blocked, true);
    db = new DatabaseSync(join(f.home, 'journal.db'), { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(db.prepare('SELECT value FROM keep').get().value, 'retained row');
    db.close();
    assert.throws(() => bootstrapManagedInstall(join(f.dir, 'other-root'), { home: f.home, publicKey: f.keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), origin: 'https://fixture.invalid/' }), /handover/);
}
finally {
    await f.close();
} });
