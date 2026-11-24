import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { inspectLegacyAdoption, launchLegacyForAdoption, stopLegacyForAdoption, adoptStoppedLegacy, releaseLegacyProof } from './legacy-adoption.mjs';
import { verifyPrivateRoot, assertNoReparse } from './private-root.mjs';
import { ManagedUpdater } from './manager.mjs';
import { buildManagedCore } from '../../../scripts/build-managed-core.mjs';
import { packageHarness } from '../../../scripts/harness-package.mjs';
import { Sinty, initHome } from '../../../packages/core/dist/sinty.js';
import { DEFAULT_ON_PLUGINS } from '../../../packages/core/dist/config.js';
import { saveProject } from '../../../packages/core/dist/roster.js';
const installRoot = process.cwd(), expectedCoreHash = createHash('sha256').update(fs.readFileSync('packages/core/dist/sinty.js')).digest('hex');
async function fixture() { const dir = fs.mkdtempSync(path.join(process.env.SINTY_UPDATER_TEST_TEMP ?? tmpdir(), 'sinty-legacy-adoption-')), home = path.join(dir, 'legacy-home'); initHome(home); const cfg = { server: { host: '127.0.0.1', port: 0 }, plugins: { enabled: [], disabled: DEFAULT_ON_PLUGINS, config: { fixture: { retained: true } }, searchPaths: [] }, supervisor: { enabled: false }, providers: {}, models: { routes: {}, fallback: [] }, updates: { enabled: false } }; fs.writeFileSync(path.join(home, 'config.yaml'), JSON.stringify(cfg)); const s = new Sinty({ home }), token = s.secrets.get('api.token'); s.agent.createSession({ title: 'legacy0.5.1 retained chat' }); s.accounts.setup({ email: 'legacy-fixture@example.invalid', password: 'fixture-only-password' }); saveProject(s.paths, { name: 'Legacy retained project' }); await s.stop(); fs.mkdirSync(path.join(home, 'data/fixture'), { recursive: true }); fs.writeFileSync(path.join(home, 'data/fixture/DATA'), 'legacy-retained-data'); fs.mkdirSync(path.join(home, 'plugins/fixture/node_modules/@sinty'), { recursive: true }); fs.symlinkSync(path.join(installRoot, 'packages/sdk'), path.join(home, 'plugins/fixture/node_modules/@sinty/sdk'), process.platform === 'win32' ? 'junction' : 'dir'); return { dir, home, token, cfg }; }
test('actual unmodified legacy0.5.1 owned probe -> verified exit -> private-ACL SAME populated home adoption -> actual managed Sinty; no PID stop guess', async () => { const f = await fixture(), root = path.join(f.dir, 'managed'), keys = generateKeyPairSync('ed25519'), options = { home: f.home, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), origin: 'http://127.0.0.1:1/', testLoopback: true }; let session, proof, manager; try {
    assert.equal(fs.existsSync(path.join(f.home, '.managed-owner.json')), false);
    const inspection = inspectLegacyAdoption({ home: f.home, installRoot });
    assert.equal(inspection.legacyVersion, '0.5.1');
    assert.equal(inspection.canAdoptRunningUnowned, false);
    await assert.rejects(adoptStoppedLegacy(root, options, { pid: process.pid }), /exit_proof/);
    assert.equal(fs.existsSync(root), false);
    const owned = await launchLegacyForAdoption({ home: f.home, installRoot, expectedCoreHash, confirmOwnedLaunch: true });
    session = owned.session;
    assert.equal((await fetch(owned.url + '/v1/sessions')).status, 401);
    assert.match(await (await fetch(owned.url + '/v1/sessions', { headers: { Authorization: 'Bearer ' + f.token } })).text(), /legacy0.5.1 retained chat/);
    assert.equal((await fetch(owned.url + '/v1/sessions', { method: 'POST' })).status, 503);
    await assert.rejects(launchLegacyForAdoption({ home: f.home, installRoot, expectedCoreHash, confirmOwnedLaunch: true }), /locked_or_unknown/);
    proof = await stopLegacyForAdoption(session);
    session = undefined;
    const before = fs.readFileSync(path.join(f.home, 'config.yaml'), 'utf8');
    await adoptStoppedLegacy(root, options, proof);
    await assert.rejects(adoptStoppedLegacy(path.join(f.dir, 'forged-root'), options, proof), /exit_proof/);
    proof = undefined;
    assert.equal(verifyPrivateRoot(root).protected, true);
    assert.equal(fs.readFileSync(path.join(f.home, 'config.yaml'), 'utf8'), before);
    assert.equal(fs.readlinkSync(path.join(f.home, 'plugins/fixture/node_modules/@sinty/sdk')).toLowerCase().replace(/[\\/]+$/, ''), path.join(installRoot, 'packages/sdk').toLowerCase());
    const snap = new DatabaseSync(path.join(root + '.legacy-backup', 'accounts.db'), { readOnly: true });
    try {
        assert.equal(snap.prepare('SELECT count(*) AS n FROM users').get().n, 1);
    }
    finally {
        snap.close();
    }
    const source = path.join(f.dir, 'new-app'), version = '0.0.1004+managed.test', manifest = await buildManagedCore({ out: source, version, uiDir: path.join(installRoot, 'apps/web/.real-managed-ui-checkpoint') }), artifact = path.join(f.dir, 'new.tgz'), pack = await packageHarness({ dir: source, out: artifact }), entry = { ...manifest, ...pack, url: options.origin + 'artifacts/' + pack.sha256 + '.tgz' };
    manager = new ManagedUpdater(root, { healthTimeoutMs: 4000 });
    const index = Buffer.from(JSON.stringify({ format: 'sinty.harness/1', sequence: 1, expires: new Date(Date.now() + 3600000).toISOString(), releases: [entry] }));
    manager.acceptCatalog(index, sign(null, index, keys.privateKey));
    await manager.receiveArtifact(pack.sha256, fs.createReadStream(artifact));
    const review = await manager.review(version);
    assert.equal((await manager.apply(review.reviewId, true)).updated, true);
    const endpoint = JSON.parse(fs.readFileSync(path.join(root, 'control/runtime-endpoint.json'), 'utf8')).url, headers = { Authorization: 'Bearer ' + f.token };
    const identity = await (await fetch(endpoint + '/v1/managed/identity', { headers })).json();
    assert.equal(identity.applicationVersion, version);
    assert.equal(identity.buildHash, manifest.appBuildHash);
    assert.match(await (await fetch(endpoint + '/v1/sessions', { headers })).text(), /legacy0.5.1 retained chat/);
    assert.equal(fs.readFileSync(path.join(f.home, 'data/fixture/DATA'), 'utf8'), 'legacy-retained-data');
    assert.equal(fs.readFileSync(path.join(f.home, 'config.yaml'), 'utf8'), before);
    const db = new DatabaseSync(path.join(f.home, 'accounts.db'), { readOnly: true });
    try {
        assert.equal(db.prepare('SELECT email FROM users').get().email, 'legacy-fixture@example.invalid');
    }
    finally {
        db.close();
    }
}
finally {
    if (manager)
        await manager.stop();
    if (session)
        proof = await stopLegacyForAdoption(session);
    if (proof)
        releaseLegacyProof(proof);
    fs.rmSync(f.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
} });
test('legacy adoption rejects changed home, wrong build pin, forged/reused proof, traversal and junction root without touching DATA', async () => { const f = await fixture(); let session, proof; try {
    await assert.rejects(launchLegacyForAdoption({ home: f.home, installRoot, expectedCoreHash: '0'.repeat(64), confirmOwnedLaunch: true }), /pin_mismatch/);
    assert.throws(() => assertNoReparse(path.join(f.dir, 'x') + '/../other'), /nontraversing/);
    const owned = await launchLegacyForAdoption({ home: f.home, installRoot, expectedCoreHash, confirmOwnedLaunch: true });
    session = owned.session;
    proof = await stopLegacyForAdoption(session);
    session = undefined;
    fs.writeFileSync(path.join(f.home, 'data/fixture/DATA'), 'changed after verified stop');
    await assert.rejects(adoptStoppedLegacy(path.join(f.dir, 'managed'), { home: f.home }, proof), /changed_or_ownership/);
    assert.equal(fs.existsSync(path.join(f.dir, 'managed')), false);
    assert.equal(fs.readFileSync(path.join(f.home, 'data/fixture/DATA'), 'utf8'), 'changed after verified stop');
    fs.writeFileSync(path.join(f.home,'data/fixture/DATA'),'legacy-retained-data');const changedDb=new DatabaseSync(path.join(f.home,'accounts.db'));changedDb.exec("UPDATE users SET first_name='changed after exit'");changedDb.close();await assert.rejects(adoptStoppedLegacy(path.join(f.dir,'managed-row-change'),{home:f.home},proof),/changed_or_ownership/);assert.equal(fs.existsSync(path.join(f.dir,'managed-row-change')),false);
}
finally {
    if (session)
        proof = await stopLegacyForAdoption(session);
    if (proof)
        releaseLegacyProof(proof);
    fs.rmSync(f.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
} });
test('legacy cold adapter retains configured providers/supervisor/plugins without executing copied background code',async()=>{const f=await fixture();let session,proof;try{const file=path.join(f.home,'config.yaml'),c=JSON.parse(fs.readFileSync(file,'utf8'));c.supervisor.enabled=true;c.providers={fixture:{protocol:'openai-compat',baseUrl:'http://127.0.0.1:1/v1',apiKey:'fixture-only'}};c.plugins.enabled=['scheduler','provider-openai-compat'];fs.writeFileSync(file,JSON.stringify(c));const before=fs.readFileSync(file,'utf8'),never=path.join(f.home,'plugins/never-execute');fs.mkdirSync(never);fs.writeFileSync(path.join(never,'sinty.plugin.json'),JSON.stringify({name:'never-execute',version:'1.0.0',kinds:['tool'],runtime:'node',entry:'main.js',editable:true,permissions:{}}));fs.writeFileSync(path.join(never,'main.js'),"require('fs').writeFileSync("+JSON.stringify(path.join(f.dir,'EXECUTED'))+",'bad')");const owned=await launchLegacyForAdoption({home:f.home,installRoot,expectedCoreHash,confirmOwnedLaunch:true});session=owned.session;assert.equal((await fetch(owned.url+'/v1/sessions',{headers:{Authorization:'Bearer '+f.token}})).status,200);proof=await stopLegacyForAdoption(session);session=undefined;assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.existsSync(path.join(f.dir,'EXECUTED')),false)}finally{if(session)proof=await stopLegacyForAdoption(session);if(proof)releaseLegacyProof(proof);fs.rmSync(f.dir,{recursive:true,force:true,maxRetries:20,retryDelay:50})}});
