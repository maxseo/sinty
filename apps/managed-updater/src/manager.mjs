import {durableLegacyCapability} from './legacy-coordinator.mjs';
import {assertNoReparse,createPrivateRoot,verifyPrivateRoot} from './private-root.mjs';
import {validatedLegacyProof} from './legacy-adoption.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectHarnessArchive } from '../../../packages/release-tools/harness-archive.mjs';
import { validPluginVersion, comparePluginVersions, satisfiesPluginRange, verifyCatalogBytes } from '../../../packages/core/src/plugin-release.ts';
const hash = b => crypto.createHash('sha256').update(b).digest('hex'), read = p => JSON.parse(fs.readFileSync(p, 'utf8')), write = (p, x) => { const t = p + '.' + crypto.randomBytes(6).toString('hex') + '.tmp'; fs.writeFileSync(t, JSON.stringify(x), { flag: 'wx', mode: 0o600, flush: true }); fs.renameSync(t, p); }, alive = pid => { try {
    process.kill(pid, 0);
    return true;
}
catch (e) {
    return e.code !== 'ESRCH';
} }, okVersion = v => typeof v === 'string' && validPluginVersion(v) && !v.includes('-');
const retiredHomes=new WeakMap();
export function bootstrapManagedInstall(root, { legacyProof,handoverProof,home, publicKey, origin, dataSchema = 'sinty-0.5.1', mode = 'managed', testLoopback = false }) { root = assertNoReparse(root); home = assertNoReparse(home); if (fs.existsSync(root) && fs.readdirSync(root).length)
    throw Error('bootstrap_requires_empty_root'); if (home === root || home.startsWith(root + path.sep) || root.startsWith(home + path.sep))
    throw Error('separate_home_required'); if (fs.existsSync(home) && fs.readdirSync(home).length && !validatedLegacyProof(legacyProof,home)&&!durableLegacyCapability(legacyProof,home) && !(handoverProof&&retiredHomes.get(handoverProof)?.validated&&retiredHomes.get(handoverProof).home===home))
    throw Error('existing_home_requires_handover_adapter'); const u = new URL(origin); if (u.pathname !== '/' || u.search || u.hash || u.username || u.password || u.protocol !== 'https:' && !(testLoopback && u.protocol === 'http:' && u.hostname === '127.0.0.1'))
    throw Error('https_origin_required'); if (crypto.createPublicKey(publicKey).asymmetricKeyType !== 'ed25519')
    throw Error('ed25519_anchor_required'); if(process.platform==='win32'){if(fs.existsSync(root))verifyPrivateRoot(root);else createPrivateRoot(root)} for (const name of ['control', 'versions', 'inbox', 'backups'])
    fs.mkdirSync(path.join(root, name), { recursive: true, mode: 0o700 }); fs.mkdirSync(home, { recursive: true }); const config = { format: 1, id:durableLegacyCapability(legacyProof,home)?.instance??crypto.randomBytes(16).toString('hex'), home, publicKey, origin: u.origin, dataSchema, mode, platform: process.platform, arch: process.arch, testLoopback, maxArtifactBytes: 512 * 1024 ** 2 }; write(path.join(root, 'control', 'install.json'), config); fs.writeFileSync(path.join(root, 'control', 'owner.token'), crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600, flush: true });write(path.join(home,".managed-owner.json"),{instance:config.id,root:durableLegacyCapability(legacyProof,home)?.root??root,state:"active"});if(handoverProof)retiredHomes.delete(handoverProof);return config; }
export function updaterPipe(root) { return process.platform === 'win32' ? '\\\\.\\pipe\\sinty-updater-' + hash(path.resolve(root)).slice(0, 24) : path.join(root, 'control', 'updater.sock'); }
export function runtimeRequest(descriptor, endpoint, body) { return new Promise((resolve, reject) => { const req = http.request({ socketPath: descriptor.pipe, path: endpoint, method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + descriptor.nonce, ...(body ? { 'Content-Type': 'application/json' } : {}) }, timeout: 3000 }, res => { let s = ''; res.on('data', b => { s += b; if (s.length > 65536)
    req.destroy(Error('response_limit')); }); res.on('end', () => { try {
    const x = JSON.parse(s);
    if (res.statusCode !== 200)
        reject(Error(x.error ?? 'runtime_request_failed'));
    else
        resolve(x);
}
catch (e) {
    reject(e);
} }); }); req.on('error', reject); req.on('timeout', () => req.destroy(Error('runtime_timeout'))); if (body)
    req.write(JSON.stringify(body)); req.end(); }); }
async function tree(root) { const result = {}; let entries = 0, total = 0; async function walk(p, rel) { if (!fs.existsSync(p))
    return; const st = fs.lstatSync(p); if (++entries > 100000)
    throw Error('persistent_entries_limit'); if (st.isSymbolicLink())
    throw Error('persistent_link_requires_review'); if (st.isDirectory()) {
    result[rel + '/'] = 'directory';
    for (const n of fs.readdirSync(p).sort())
        await walk(path.join(p, n), rel ? rel + '/' + n : n);
}
else if (st.isFile()) {
    if ((total += st.size) > 8 * 1024 ** 3)
        throw Error('persistent_scan_limit');
    result[rel] = await fileHash(p);
}
else
    throw Error('persistent_special_file'); } await walk(root, ''); return result; }
async function captureState(home) { const { DatabaseSync } = await import('node:sqlite'), files = {}; for (const name of ['config.yaml', 'policy.yaml', 'AGENTS.md'])
    files[name] = fs.existsSync(path.join(home, name)) ? await fileHash(path.join(home, name)) : null; files.data = await tree(path.join(home, 'data')); const schemas = {}; for (const name of ['journal.db', 'accounts.db']) {
    const p = path.join(home, name);
    if (!fs.existsSync(p)) {
        schemas[name] = null;
        continue;
    }
    const db = new DatabaseSync(p, { readOnly: true });
    try {
        schemas[name] = hash(JSON.stringify([db.prepare('PRAGMA user_version').get(), db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()]));
    }
    finally {
        db.close();
    }
} return { files, schemas }; }
async function snapshot(home, out) { fs.mkdirSync(out, { recursive: true }); const { DatabaseSync, backup } = await import('node:sqlite'); for (const name of ['journal.db', 'accounts.db']) {
    const p = path.join(home, name);
    if (fs.existsSync(p)) {
        const db = new DatabaseSync(p, { readOnly: true });
        try {
            await backup(db, path.join(out, name));
        }
        finally {
            db.close();
        }
    }
} for (const name of ['config.yaml', 'policy.yaml', 'AGENTS.md'])
    if (fs.existsSync(path.join(home, name)))
        fs.copyFileSync(path.join(home, name), path.join(out, name)); return captureState(home); }
async function compatibleData(home, before) { return JSON.stringify(before) === JSON.stringify(await captureState(home)); }
export class ManagedUpdater {
    constructor(root, { healthTimeoutMs = 10000, drainTimeoutMs = 5000, crashAt } = {}) { this.root = assertNoReparse(root);if(process.platform==='win32')verifyPrivateRoot(this.root);for(const p of ['control','control/install.json','control/owner.token'])assertNoReparse(this.file(p)); this.config = read(this.file('control/install.json')); this.token = fs.readFileSync(this.file('control/owner.token'), 'utf8'); this.healthTimeoutMs = healthTimeoutMs; this.drainTimeoutMs = drainTimeoutMs; this.crashAt = crashAt; this.reviews = new Map(); this.children = new Map(); if (this.config.format !== 1 || !/^[a-f0-9]{32}$/.test(this.config.id))
        throw Error('invalid_install_identity'); }
    file(p) { return path.join(this.root, p); }
    ensureHomeOwnership(){const owner=read(path.join(this.config.home,".managed-owner.json"));if(owner.instance!==this.config.id||owner.root!==this.root||owner.state!=="active"||this.config.mode!=="managed")throw Error("managed_home_not_owned")}
    async retireForHandover(){return this.lock(async()=>{this.ensureHomeOwnership();const j=this.journal();if(j&&!["committed","rolled_back"].includes(j.phase))throw Error("handover_requires_healthy_state");const current=this.current();if(!current)throw Error("owned_runtime_required");await this.stopRuntime(current);const until=Date.now()+3000;while(alive(current.pid)&&Date.now()<until)await delay(25);if(alive(current.pid))throw Error("owned_runtime_not_exited");const backup="backups/handover-"+Date.now();const state=await snapshot(this.config.home,this.file(backup));this.config.mode="retired";write(this.file("control/install.json"),this.config);write(path.join(this.config.home,".managed-owner.json"),{instance:this.config.id,root:this.root,state:"handover"});const proof={};retiredHomes.set(proof,{home:this.config.home,state,pid:current.pid,source:this.root,validated:false});return proof})}
    current() { const d = fs.existsSync(this.file('control/current.json')) ? read(this.file('control/current.json')) : null; if (d)
        this.checkDescriptor(d); return d; }
    checkDescriptor(d) { if (!okVersion(d.version) || !/^[a-f0-9]{64}$/.test(d.sha256) || d.directory !== d.version + '-' + d.sha256 || d.instance !== this.config.id || !/^[a-f0-9]{64}$/.test(d.nonce))
        throw Error('unsafe_runtime_descriptor'); }
    mac(x) { return crypto.createHmac('sha256', this.token).update(JSON.stringify(x)).digest('hex'); }
    persist(j) { write(this.file('control/journal.json'), { record: j, mac: this.mac(j) }); }
    journal() { if (!fs.existsSync(this.file('control/journal.json')))
        return null; let value; try {
        value = read(this.file('control/journal.json'));
    }
    catch {
        throw Error('invalid_update_journal');
    } if (!value.record || value.mac !== this.mac(value.record))
        throw Error('untrusted_update_journal'); return value.record; }
    status() { try {
        const j = this.journal();
        return { mode: this.config.mode, current: this.current()?.version ?? null, phase: j?.phase ?? 'idle', operation:fs.existsSync(this.file('control/last-operation.json'))?read(this.file('control/last-operation.json')):null, blocked: j?.phase === 'blocked', lastError: j?.error ?? null };
    }
    catch {
        return { mode: this.config.mode, current: null, phase: 'recovery-required', blocked: true, lastError: 'invalid_update_state' };
    } }
    note(j, phase) { j.phase = phase; j.updated = Date.now(); this.persist(j); if (this.crashAt === phase)
        process.exit(77); }
    async lock(action) { const p = this.file('control/operation.lock'), nonce = crypto.randomBytes(16).toString('hex'), payload = { pid: process.pid, instance: this.config.id, nonce }, mac = x => crypto.createHmac('sha256', this.token).update(JSON.stringify(x)).digest('hex'); try {
        fs.writeFileSync(p, JSON.stringify({ ...payload, mac: mac(payload) }), { flag: 'wx', mode: 0o600, flush: true });
    }
    catch (e) {
        if (e.code !== 'EEXIST')
            throw e;
        const old = read(p), { mac: signature, ...value } = old;
        if (signature !== mac(value) || old.instance !== this.config.id || !Number.isSafeInteger(old.pid) || old.pid <= 0 || alive(old.pid))
            throw Error('update_lock_owned_or_unknown');
        fs.renameSync(p, p + '.abandoned.' + old.nonce);
        return this.lock(action);
    } try {
        return await action();
    }
    finally {
        if (fs.existsSync(p) && read(p).nonce === nonce)
            fs.unlinkSync(p);
    } }
    acceptCatalog(bytes, signature) { if (!verifyCatalogBytes(bytes, signature, this.config.publicKey))
        throw Error('release_signature_invalid'); const x = JSON.parse(bytes); if (x.format !== 'sinty.harness/1' || !Number.isSafeInteger(x.sequence) || x.sequence < 0 || !Array.isArray(x.releases) || x.releases.length > 10000 || !Number.isFinite(Date.parse(x.expires)) || Date.parse(x.expires) <= Date.now())
        throw Error('invalid_release_index'); const previous = fs.existsSync(this.file('control/catalog.json')) ? read(this.file('control/catalog.json')) : { sequence: 0, known: {} }; if (x.sequence < previous.sequence)
        throw Error('release_index_replay'); const seen = new Set(); for (const r of x.releases) {
        if (!okVersion(r.version) || !/^[a-f0-9]{64}$/.test(r.sha256) || !Number.isSafeInteger(r.bytes) || r.bytes < 1 || r.bytes > this.config.maxArtifactBytes || r.channel !== 'stable' || !['win32', 'linux'].includes(r.platform) || !['x64', 'arm64'].includes(r.arch))
            throw Error('invalid_release_entry');
        const u = new URL(r.url);
        if (u.origin !== this.config.origin || u.username || u.password || u.search || u.hash || u.pathname !== '/artifacts/' + r.sha256 + '.tgz')
            throw Error('release_source_mismatch');
        const id = [r.version, r.platform, r.arch, r.channel].join('/');
        if (seen.has(id) || previous.known[id] && previous.known[id] !== r.sha256)
            throw Error('immutable_release_conflict');
        seen.add(id);
        previous.known[id] = r.sha256;
    } write(this.file('control/catalog.json'), { sequence: x.sequence, known: previous.known, index: x }); return { versions: x.releases.filter(r => r.platform === this.config.platform && r.arch === this.config.arch).map(r => r.version) }; }
    release(version) { const index=read(this.file('control/catalog.json')).index;if(!Number.isFinite(Date.parse(index.expires))||Date.parse(index.expires)<=Date.now())throw Error('release_index_expired');const r = index.releases.find(r => r.version === version && r.platform === this.config.platform && r.arch === this.config.arch && r.channel === 'stable'); if (!r)
        throw Error('release_not_available'); return r; }
    async receiveArtifact(digest, input) { if (!/^[a-f0-9]{64}$/.test(digest))
        throw Error('invalid_digest'); const index = read(this.file('control/catalog.json')).index, r = index.releases.find(x => x.sha256 === digest); if (!r)
        throw Error('untrusted_artifact'); const p = this.file('inbox/' + digest + '.tgz'), tmp = p + '.' + crypto.randomBytes(6).toString('hex') + '.tmp', fd = fs.openSync(tmp, 'wx', 0o600), h = crypto.createHash('sha256'); let size = 0; try {
        for await (const chunk of input) {
            const b = Buffer.from(chunk);
            size += b.length;
            if (size > r.bytes || size > this.config.maxArtifactBytes)
                throw Error('artifact_size_limit');
            h.update(b);
            fs.writeSync(fd, b);
        }
        fs.fsyncSync(fd);
        if (size !== r.bytes || h.digest('hex') !== digest)
            throw Error('artifact_hash_mismatch');
        fs.closeSync(fd);
        if (fs.existsSync(p)) {
            if (await fileHash(p) !== digest)
                throw Error('stored_artifact_tampered');
            fs.unlinkSync(tmp);
        }
        else
            fs.renameSync(tmp, p);
        return { staged: true };
    }
    catch (e) {
        try {
            fs.closeSync(fd);
        }
        catch { }
        if (fs.existsSync(tmp))
            fs.unlinkSync(tmp);
        throw e;
    } }
    async review(version) {
        if(this.config.mode!=="managed")throw Error("development_checkout_not_updatable");this.ensureHomeOwnership();
 if(process.platform!=="win32")throw Error("windows_managed_only"); if (this.config.mode !== 'managed')
        throw Error('development_checkout_not_updatable'); const current = this.current(); if (current && comparePluginVersions(version, current.version) <= 0)
        throw Error('downgrade_or_same_version'); const r = this.release(version), file = this.file('inbox/' + r.sha256 + '.tgz'); if (await fileHash(file) !== r.sha256)
        throw Error('artifact_hash_mismatch'); const info = await inspectHarnessArchive(file); this.validateManifest(info.manifest, r); if (!info.files.has('app/managed-main.mjs'))
        throw Error('fixed_managed_entry_required'); const id = crypto.randomBytes(24).toString('hex'); this.reviews.set(id, { release: r, manifest: info.manifest, expires: Date.now() + 120000, current: current?.sha256 ?? null }); return { reviewId: id, version, installedVersion: current?.version ?? null, changelog: info.changelog, compatible: true, requiresRestart: true, dataPolicy: 'no-migrations', coreVersion:info.manifest.coreVersion,sdkVersion:info.manifest.sdkVersion,nodeRange:info.manifest.nodeRange,dataSchema:info.manifest.dataSchema,compatibility:info.manifest.compatibility??{},sha256:r.sha256,bytes:r.bytes,platform:r.platform,arch:r.arch }; }
    validateManifest(m, r) {
 for(const key of ["coreVersion","sdkVersion","updaterProtocol","nodeRange","dataSchema","migrations","dataCompatibility"])if(m[key]!==r[key])throw Error("release_metadata_mismatch");
 for(const key of ["core","sdk"]){const range=m.compatibility?.[key];if(range!==undefined&&(typeof range!=="string"||!satisfiesPluginRange(m[key+"Version"],range)))throw Error("release_core_sdk_incompatible")} if (m.updaterProtocol !== 1)
        throw Error('updater_protocol_required'); for (const k of ['version', 'platform', 'arch', 'channel'])
        if (m[k] !== r[k])
            throw Error('release_identity_mismatch'); if (m.migrations !== 'none' || m.dataCompatibility !== 'unchanged' || m.dataSchema !== this.config.dataSchema)
        throw Error('unsupported_data_migration'); if (typeof m.nodeRange !== 'string' || !satisfiesPluginRange(process.versions.node, m.nodeRange))
        throw Error('node_incompatible'); if (!validPluginVersion(m.coreVersion) || !validPluginVersion(m.sdkVersion))
        throw Error('invalid_core_sdk_version'); if (m.command !== undefined || m.args !== undefined || m.scripts !== undefined)
        throw Error('release_cannot_supply_commands'); }
    descriptor(target) { const nonce = crypto.randomBytes(32).toString('hex'); return { ...target, nonce, pipe: process.platform === 'win32' ? '\\\\.\\pipe\\sinty-runtime-' + this.config.id + '-' + nonce.slice(0, 16) : this.file('control/runtime-' + nonce.slice(0, 16) + '.sock'), pid: 0, instance: this.config.id }; }
    async probe(d) { const x = await runtimeRequest(d, '/status'); if (x.instance !== this.config.id || x.version !== d.version || x.sha256 !== d.sha256 || d.pid && x.pid !== d.pid)
        throw Error('runtime_identity_mismatch'); return x; }
    async verifyVersion(d) { this.checkDescriptor(d); const value = read(this.file('control/receipt-' + d.sha256 + '.json')); if (!value.record || value.mac !== this.mac(value.record) || value.record.sha256 !== d.sha256 || JSON.stringify(value.record.tree) !== JSON.stringify(await tree(this.file('versions/' + d.directory))))
        throw Error('version_integrity_failed'); }
    async launch(d, onSpawn) { await this.verifyVersion(d); const child = fork(new URL('./runtime-host.mjs', import.meta.url), [], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); this.children.set(d.nonce, child); d.pid = child.pid; onSpawn?.(); child.on('error', () => { }); child.send({ root: this.root, home: this.config.home, descriptor: d }, () => { if (child.connected)
        child.disconnect(); }); child.unref(); const deadline = Date.now() + this.healthTimeoutMs; while (Date.now() < deadline) {
        try {
            const x = await this.probe(d);
            if (x.failed)
                throw Error('candidate_start_failed');
            if (x.ready)
                return;
        }
        catch (e) {
            if (e.message === 'candidate_start_failed')
                throw e;
        }
        if (child.exitCode !== null)
            throw Error('candidate_process_exit');
        await delay(40);
    } throw Error('candidate_health_timeout'); }
    async stopRuntime(d) { let status; try {
        status = await this.probe(d);
    }
    catch (e) {
        if (d.pid && !alive(d.pid))
            return;
        throw Error('unverified_runtime_ownership');
    } await runtimeRequest(d, '/drain', { timeoutMs: this.drainTimeoutMs }); await runtimeRequest(d, '/stop', {}); const end = Date.now() + 4000; while (Date.now() < end) {
        try {
            await this.probe(d);
        }
        catch {
            return;
        }
        await delay(25);
    } throw Error('owned_runtime_stop_timeout'); }
    queueApply(id,confirm){const ticket=this.reviews.get(id);if(confirm!==true||!ticket||ticket.expires<Date.now())throw Error('explicit_fresh_review_required');if(this.operationFlight)throw Error('update_already_queued');const operationId=crypto.randomBytes(16).toString('hex'),save=value=>write(this.file('control/last-operation.json'),{operationId,...value});this.operationFlight=true;save({state:'queued',version:ticket.release.version});setTimeout(()=>{void this.apply(id,true).then(result=>save({state:result.updated?'committed':result.blocked?'blocked':'rolled_back',...result})).catch(()=>save({state:'failed',error:'managed_update_failed'})).finally(()=>{this.operationFlight=false})},100);return{accepted:true,operationId}}
    async apply(id, confirm) {
        this.ensureHomeOwnership(); if (confirm !== true)
        throw Error('explicit_owner_confirmation_required'); const ticket = this.reviews.get(id); if (!ticket || ticket.expires < Date.now())
        throw Error('review_expired'); return this.lock(async () => { const old = this.current(); if ((old?.sha256 ?? null) !== ticket.current)
        throw Error('installation_changed_since_review'); if (this.journal() && !['committed', 'rolled_back'].includes(this.journal().phase))
        throw Error('recovery_required'); const r = ticket.release; if (this.release(r.version).sha256 !== r.sha256)
        throw Error('release_changed'); const versionDir = r.version + '-' + r.sha256, stage = this.file('versions/.stage-' + crypto.randomBytes(12).toString('hex')); if (await fileHash(this.file('inbox/' + r.sha256 + '.tgz')) !== r.sha256)
        throw Error('artifact_hash_mismatch'); const info = await inspectHarnessArchive(this.file('inbox/' + r.sha256 + '.tgz'), { destination: stage }); this.validateManifest(info.manifest, r); const target = { version: r.version, sha256: r.sha256, directory: versionDir }; if (fs.existsSync(this.file('versions/' + versionDir))) {
        await this.verifyVersion({ ...target, instance: this.config.id, nonce: '0'.repeat(64) });
        fs.rmSync(stage, { recursive: true, force: true });
    }
    else {
        fs.renameSync(stage, this.file('versions/' + versionDir));
        const record = { sha256: r.sha256, tree: await tree(this.file('versions/' + versionDir)) };
        write(this.file('control/receipt-' + r.sha256 + '.json'), { record, mac: this.mac(record) });
    } const j = { format: 1, instance: this.config.id, old, candidate: this.descriptor(target), phase: 'prepared', oldStopped: false, backup: 'backups/' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') }; this.note(j, 'prepared'); try {
        this.note(j, 'stop_intent');
        if (old)
            await this.stopRuntime(old);
        j.oldStopped = true;
        this.note(j, 'old_stopped');
        j.data = await snapshot(this.config.home, this.file(j.backup));
        this.note(j, 'launch_intent');
        j.candidate.spawnAttempted = true;
        this.persist(j);
        if (this.crashAt === 'spawn_pending')
            process.exit(77);
        const launching = this.launch(j.candidate);
        write(this.file('control/journal.json'), j);
        await launching;
        this.note(j, 'healthy');
        write(this.file('control/current.json'), j.candidate);
        if (this.crashAt === 'pointer_written')
            process.exit(77);
        this.note(j, 'committed');
        this.reviews.delete(id);
        return { updated: true, version: r.version };
    }
    catch (e) {
        j.error = e.message;
        return this.rollback(j);
    } }); }
    async rollback(j) { this.note(j, 'rollback_intent'); try {
        if (j.old && !j.oldStopped) {
            try {
                await this.probe(j.old);
                await runtimeRequest(j.old, '/resume', {});
                this.note(j, 'rolled_back');
                return { updated: false, rolledBack: true, error: j.error ?? 'interrupted_update', version: j.old.version };
            }
            catch {
                if (j.old.pid && alive(j.old.pid))
                    throw Error('old_runtime_ownership_unconfirmed');
            }
        }
        if (j.candidate) {
            if (j.candidate.spawnAttempted && !j.candidate.pid) {
                let confirmed = false;
                const until = Date.now() + 500;
                while (Date.now() < until) {
                    try {
                        const proof = await this.probe(j.candidate);
                        j.candidate.pid = proof.pid;
                        confirmed = true;
                        break;
                    }
                    catch {
                        await delay(30);
                    }
                }
                if (!confirmed)
                    throw Error('candidate_launch_unconfirmed');
            }
            try {
                await this.stopRuntime(j.candidate);
            }
            catch (e) {
                const child = this.children.get(j.candidate.nonce);
                if (child && child.exitCode === null) {
                    child.kill();
                    await new Promise(resolve => child.once('exit', resolve));
                }
                else if (j.candidate.pid && alive(j.candidate.pid))
                    throw e;
            }
        }
        if (j.data && !await compatibleData(this.config.home, j.data))
            throw Error('data_changed_rollback_requires_review');
        if (j.old) {
            j.old = this.descriptor(j.old);
            await this.launch(j.old);
            write(this.file('control/current.json'), j.old);
        }
        this.note(j, 'rolled_back');
        return { updated: false, rolledBack: true, error: j.error ?? 'interrupted_update', version: j.old?.version ?? null };
    }
    catch (e) {
        j.error = e.message;
        this.note(j, 'blocked');
        return { updated: false, rolledBack: false, blocked: true, error: j.error };
    } }
    async recover() {
        this.ensureHomeOwnership(); return this.lock(async () => { const j = this.journal(); if (!j)
        return { recovered: false }; if (j.format !== 1 || j.instance !== this.config.id || !['prepared', 'stop_intent', 'old_stopped', 'launch_intent', 'healthy', 'committed', 'rollback_intent', 'rolled_back', 'blocked'].includes(j.phase))
        throw Error('unknown_update_journal'); for (const d of [j.old, j.candidate].filter(Boolean))
        if (!okVersion(d.version) || !/^[a-f0-9]{64}$/.test(d.sha256) || d.directory !== d.version + '-' + d.sha256 || d.instance !== this.config.id || !/^[a-f0-9]{64}$/.test(d.nonce))
            throw Error('unsafe_update_journal'); if (j.phase === 'blocked')
        return { blocked: true, error: j.error }; if (j.phase === 'committed' || j.phase === 'rolled_back') {
        const current = this.current();
        if (current) {
            try {
                await this.probe(current);
            }
            catch {
                if (current.pid && alive(current.pid))
                    throw Error('current_runtime_ownership_unconfirmed');
                const next = this.descriptor(current);
                await this.launch(next);
                write(this.file('control/current.json'), next);
                if (j.phase === 'committed')
                    j.candidate = next;
                else
                    j.old = next;
                this.note(j, j.phase);
            }
        }
        return { recovered: false, phase: j.phase };
    } ; if (j.phase === 'prepared') {
        this.note(j, 'rolled_back');
        return { recovered: true, oldRetained: true };
    } if (j.phase === 'stop_intent') {
        try {
            const x = await this.probe(j.old);
            if (x.ready) {
                await runtimeRequest(j.old, '/resume', {});
                this.note(j, 'rolled_back');
                return { recovered: true, oldRetained: true };
            }
        }
        catch { }
    } return this.rollback(j); }); }
    async stop() { const c = this.current(); if (c)
        await this.stopRuntime(c); }
}
export async function fileHash(file) { const h = crypto.createHash('sha256'); for await (const b of fs.createReadStream(file))
    h.update(b); return h.digest('hex'); }
export function createUpdaterServer(manager) { const server = http.createServer(async (req, res) => { try {
    const value = String(req.headers.authorization ?? ''), expected = 'Bearer ' + manager.token;
    if (Buffer.byteLength(value) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected)))
        throw Error('owner_auth_required');
    const u = new URL(req.url, 'http://ipc.invalid');
    if (req.method === 'GET' && u.pathname === '/status') {
        res.end(JSON.stringify(manager.status()));
        return;
    }
    if (req.method === 'PUT' && /^\/artifacts\/[a-f0-9]{64}$/.test(u.pathname)) {
        res.end(JSON.stringify(await manager.receiveArtifact(u.pathname.split('/').pop(), req)));
        return;
    }
    let length = 0, parts = [];
    for await (const b of req) {
        length += b.length;
        if (length > 2 * 1024 ** 2)
            throw Error('request_limit');
        parts.push(b);
    }
    const x = JSON.parse(Buffer.concat(parts).toString() || '{}');
    let result;
    if (req.method === 'POST' && u.pathname === '/catalog')
        result = manager.acceptCatalog(Buffer.from(x.index, 'base64'), Buffer.from(x.signature, 'base64'));
    else if (req.method === 'POST' && u.pathname === '/review')
        result = await manager.review(x.version);
    else if (req.method === 'POST' && u.pathname === '/apply')
        {res.statusCode=202;result = manager.queueApply(x.reviewId, x.confirm);}
    else if (req.method === 'POST' && u.pathname === '/recover')
        result = await manager.recover();
    else
        throw Error('unsupported_owner_action');
    res.end(JSON.stringify(result));
}
catch (e) {
    res.statusCode = e.message === 'owner_auth_required' ? 401 : 409;
    res.end(JSON.stringify({ error: e.message }));
} }); server.requestTimeout = 600000; return server; }

export async function bootstrapStoppedHome(root,options,proof){const value=retiredHomes.get(proof);if(!value||value.home!==path.resolve(options.home)||alive(value.pid)||!await compatibleData(value.home,value.state))throw Error("handover_proof_invalid_or_home_changed");const lease=read(path.join(value.home,".managed-owner.json"));if(lease.state!=="handover"||lease.root!==value.source)throw Error("handover_ownership_changed");value.validated=true;return bootstrapManagedInstall(root,{...options,handoverProof:proof})}
