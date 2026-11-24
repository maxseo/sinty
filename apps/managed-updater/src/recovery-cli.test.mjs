import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { bootstrapManagedInstall } from './manager.mjs';
test('standalone owner recovery CLI works with no core HTTP; corrupt journal remains blocked/intact and confirm is mandatory', () => { const dir = fs.mkdtempSync(join(tmpdir(), 'sinty-recovery-cli-')), root = join(dir, 'managed'), home = join(dir, 'home'), keys = generateKeyPairSync('ed25519'); try {
    bootstrapManagedInstall(root, { home, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), origin: 'https://fixture.invalid/' });
    const cli = 'apps/managed-updater/dist/src/recovery-cli.mjs', run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true });
    let r = run('status', root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).phase, 'idle');
    r = run('recover', root);
    assert.notEqual(r.status, 0);
    const journal = join(root, 'control/journal.json');
    fs.writeFileSync(journal, 'damaged synthetic evidence');
    r = run('status', root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).blocked, true);
    r = run('recover', root, '--confirm');
    assert.notEqual(r.status, 0);
    assert.equal(fs.readFileSync(journal, 'utf8'), 'damaged synthetic evidence');
    assert.equal(fs.existsSync(join(root, 'control/current.json')), false);
    assert.doesNotMatch(r.stdout + r.stderr, /owner\.token|nonce|Bearer|snt_/);
}
finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
} });
