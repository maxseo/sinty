import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createPrivateRoot, verifyPrivateRoot, assertNoReparse } from './private-root.mjs';
test('native private helper root: real owner writes; protected DACL excludes untrusted principals; existing roots and junctions refused', () => {
    const temp = fs.mkdtempSync(path.join(process.env.SINTY_UPDATER_TEST_TEMP ?? tmpdir(), 'sinty-acl-'));
    try {
        const root = path.join(temp, 'managed');
        const acl = createPrivateRoot(root);
        assert.equal(acl.untrustedWriteAllowed, false);
        fs.writeFileSync(path.join(root, 'owner-access'), 'fixture');
        assert.equal(fs.readFileSync(path.join(root, 'owner-access'), 'utf8'), 'fixture');
        assert.equal(verifyPrivateRoot(root).protected, true);
        assert.throws(() => createPrivateRoot(root), /fresh_private/);
        const alias = path.join(temp, 'alias');
        fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => assertNoReparse(path.join(alias, 'control')), /reparse/);
        assert.throws(() => createPrivateRoot(path.join(alias, 'nested')), /reparse/);
        assert.equal(fs.existsSync(path.join(root, 'nested')), false);
        if (process.platform === 'win32') {
            assert.throws(() => assertNoReparse(root + '\\file:stream'), /unsafe_windows/);assert.throws(()=>assertNoReparse(String.fromCharCode(92,92)+'server'+String.fromCharCode(92)+'share'),/network_root/);
            const unsafe = path.join(temp, 'intentionally-unsafe');
            fs.mkdirSync(unsafe);
            const mutate = String.raw `$ErrorActionPreference='Stop';$p=$env:SINTY_ACL_FIXTURE;$a=New-Object System.Security.AccessControl.DirectorySecurity;$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);foreach($who in @($sid,(New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))){$full=New-Object System.Security.AccessControl.FileSystemAccessRule($who,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$a.AddAccessRule($full)|Out-Null};$id=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0');$r=New-Object System.Security.AccessControl.FileSystemAccessRule($id,'Write,DeleteSubdirectoriesAndFiles','None','None','Allow');$a.AddAccessRule($r)|Out-Null;Set-Acl -LiteralPath $p -AclObject $a`;
            execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', mutate], { env: { ...process.env, SINTY_ACL_FIXTURE: unsafe }, windowsHide: true, stdio: 'pipe' });
            assert.throws(() => verifyPrivateRoot(unsafe), /unexpected_control_acl/);
            assert.throws(() => createPrivateRoot(path.join(unsafe, 'untrusted-child')), /untrusted_parent_write_denied/);
            assert.equal(fs.existsSync(path.join(unsafe, 'untrusted-child')), false);
        }
    }
    finally {
        fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
});
