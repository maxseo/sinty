import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync, backup } from 'node:sqlite';
import { assertNoReparse, createPrivateRoot, verifyPrivateRoot } from './private-root.mjs';
import { bootstrapManagedInstall } from './manager.mjs';
const proofs = new WeakMap(), sessions = new WeakMap(), hash = b => crypto.createHash('sha256').update(b).digest('hex');
export function inspectLegacyAdoption({ home, installRoot }) { home = assertNoReparse(home); installRoot = assertNoReparse(installRoot); const release = JSON.parse(fs.readFileSync(path.join(installRoot, 'release.json'), 'utf8')); return { legacyVersion: release.version, requiresExplicitOwnedLaunch: true, canAdoptRunningUnowned: false, reason: 'Unmodified0.5.1 has no authenticated drain/ownership channel. PID, port and command line alone are not stop authority; no process will be signalled.', locked: fs.existsSync(path.join(home, '.legacy-adoption.lock')), alreadyManaged: fs.existsSync(path.join(home, '.managed-owner.json')) }; }
export async function legacyFingerprint(home) { const out = {}; let count = 0, total = 0; async function walk(dir, rel = '') { for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? rel + '/' + ent.name : ent.name;
    if ((r === '.legacy-adoption.lock'||r==='.managed-owner.json') || /^(?:secrets\.json|secret\.key|\.env)$/.test(r) || /^(?:journal|accounts)\.db-(?:wal|shm)$/.test(r))
        continue;
    if (++count > 100000)
        throw Error('legacy_home_entries_limit');
    const p = path.join(dir, ent.name), st = fs.lstatSync(p);
    if (st.isSymbolicLink()) {
        out[r] = { link: fs.readlinkSync(p) };
        continue;
    }
    if (st.isDirectory()) {
        out[r + '/'] = 'directory';
        await walk(p, r);
    }
    else if (st.isFile()) {
        if ((total += st.size) > 8 * 1024 ** 3)
            throw Error('legacy_home_bytes_limit');
        const h = crypto.createHash('sha256');
        if (['journal.db', 'accounts.db'].includes(r)) {
            const db = new DatabaseSync(p, { readOnly: true });
            try {
                db.exec('BEGIN');
                h.update(JSON.stringify(db.prepare('PRAGMA user_version').get()));
                for (const t of db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()) {
                    h.update(JSON.stringify(t));
                    if (t.type === 'table') {
                        const statement = db.prepare('SELECT * FROM ' + JSON.stringify(t.name));
                        statement.setReadBigInts(true);
                        for (const row of statement.iterate())
                            h.update(JSON.stringify(row, (_, v) => typeof v === 'bigint' ? v.toString() + 'n' : v));
                    }
                }
                db.exec('ROLLBACK');
            }
            finally {
                db.close();
            }
        }
        else
            for await (const b of fs.createReadStream(p))
                h.update(b);
        out[r] = h.digest('hex');
    }
    else
        throw Error('legacy_home_special_file');
} } await walk(home); return hash(JSON.stringify(out)); }
export function validatedLegacyProof(proof, home) { const p = proofs.get(proof); return !!p?.validated && !p.used && p.home === path.resolve(home) && p.child.exitCode === 0; }
export async function launchLegacyForAdoption({ home, installRoot, expectedCoreHash, confirmOwnedLaunch = false }) { if (confirmOwnedLaunch !== true)
    throw Error('explicit_owned_legacy_launch_required'); home = assertNoReparse(home); installRoot = assertNoReparse(installRoot); for (const name of ['config.yaml', 'policy.yaml', 'AGENTS.md', 'journal.db', 'accounts.db', 'secrets.json', 'secret.key', 'blobs', 'data', 'workspace', 'plugins', 'skills'])
    assertNoReparse(path.join(home, name)); if (fs.existsSync(path.join(home, '.managed-owner.json')))
    throw Error('legacy_home_already_managed'); const entry = path.join(installRoot, 'packages/core/dist/sinty.js'); assertNoReparse(entry); if (hash(fs.readFileSync(entry)) !== expectedCoreHash)
    throw Error('legacy_core_pin_mismatch'); if (inspectLegacyAdoption({ home, installRoot }).legacyVersion !== '0.5.1')
    throw Error('unsupported_legacy_version'); const lock = path.join(home, '.legacy-adoption.lock'), nonce = crypto.randomBytes(32).toString('hex'); let fd; try {
    fd = fs.openSync(lock, 'wx', 0o600);
}
catch {
    throw Error('legacy_home_locked_or_unknown_owner');
} fs.writeFileSync(fd, nonce); const child = fork(new URL('./legacy-host.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true }); const session = {}, exited = new Promise(resolve => child.once('exit', code => resolve(code))); child.on('error', () => { }); let message; try {
    message = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('legacy_probe_start_timeout')), 10000); child.on('message', x => {if(x.type==='boot-ready')child.send({home,installRoot,nonce,expectedCoreHash}); if (x.type === 'ready') {
        clearTimeout(timer);
        resolve(x);
    }
    else if (x.type === 'error') {
        clearTimeout(timer);
        reject(Error(x.error));
    } }); child.once('exit', () => { clearTimeout(timer); reject(Error('legacy_probe_exited')); });  });
}
catch (e) {
    if (child.connected)
        child.send({ action: 'stop', nonce }, () => { });
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000).unref())]);
    if (child.exitCode === null)
        throw Error('legacy_start_uncertain_lock_retained_no_kill');
    fs.closeSync(fd);
    if (fs.readFileSync(lock, 'utf8') === nonce)
        fs.unlinkSync(lock);
    throw e;
} sessions.set(session, { home, installRoot, expectedCoreHash, lock, fd, nonce, child, url: message.url }); return { session, url: message.url, legacyVersion: '0.5.1', profile: 'cold-read-only-no-plugin-start' }; }
export async function stopLegacyForAdoption(session) { const s = sessions.get(session); if (!s || s.stopping)
    throw Error('owned_legacy_session_required'); s.stopping = true; const exit = once(s.child, 'exit'); s.child.send({ action: 'stop', nonce: s.nonce }); const timer = setTimeout(() => { }, 15000); timer.unref(); let code; try {
    [code] = await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(Error('owned_legacy_stop_timeout_no_kill')), 10000).unref())]);
}
finally {
    clearTimeout(timer);
} if (code !== 0)
    throw Error('legacy_exit_not_verified'); const proof = {}; proofs.set(proof, { ...s, fingerprint: await legacyFingerprint(s.home), validated: false, used: false }); sessions.delete(session); return proof; }
export async function adoptStoppedLegacy(root, options, proof) { const p = proofs.get(proof); if (!p || p.used || p.adopting || p.child.exitCode !== 0 || p.home !== path.resolve(options.home))
    throw Error('legacy_exit_proof_required'); p.adopting = true; try {
    if (fs.readFileSync(p.lock, 'utf8') !== p.nonce || await legacyFingerprint(p.home) !== p.fingerprint)
        throw Error('legacy_home_changed_or_ownership_lost');
    root = assertNoReparse(root);
    createPrivateRoot(root);
    const snapshotRoot = root + '.legacy-backup';
    createPrivateRoot(snapshotRoot);
    for (const name of ['journal.db', 'accounts.db']) {
        const file = path.join(p.home, name);
        if (fs.existsSync(file)) {
            const db = new DatabaseSync(file, { readOnly: true });
            try {
                await backup(db, path.join(snapshotRoot, name));
            }
            finally {
                db.close();
            }
        }
    }
    for (const name of ['config.yaml', 'policy.yaml', 'AGENTS.md'])
        if (fs.existsSync(path.join(p.home, name)))
            fs.copyFileSync(path.join(p.home, name), path.join(snapshotRoot, name));
    if (await legacyFingerprint(p.home) !== p.fingerprint)
        throw Error('legacy_home_changed_during_snapshot');
    verifyPrivateRoot(root);
    p.validated = true;
    const result = bootstrapManagedInstall(root, { ...options, legacyProof: proof });
    p.used = true;
    fs.writeFileSync(path.join(root, 'control/legacy-adoption.json'), JSON.stringify({ format: 1, legacyVersion: '0.5.1', coreHash: p.expectedCoreHash, profile: 'cold-read-only-no-plugin-start', snapshotRoot, sameHome: true }), { mode: 0o600, flush: true });
    fs.closeSync(p.fd);
    if (fs.readFileSync(p.lock, 'utf8') === p.nonce)
        fs.unlinkSync(p.lock);
    proofs.delete(proof);
    return result;
}
finally {
    p.adopting = false;
} }
export function releaseLegacyProof(proof) { const p = proofs.get(proof); if (!p || p.used || p.adopting || p.child.exitCode !== 0)
    throw Error("stopped_owned_proof_required"); fs.closeSync(p.fd); if (fs.readFileSync(p.lock, "utf8") !== p.nonce)
    throw Error("legacy_lock_ownership_changed"); fs.unlinkSync(p.lock); proofs.delete(proof); }
