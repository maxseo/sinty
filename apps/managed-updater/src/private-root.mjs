import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
/** Reject reparse points in every existing component, not only the final path. */
export function assertNoReparse(input) { if (!path.isAbsolute(input) || input.split(/[\\/]/).some(x => x === ".." || x === "."))
    throw Error("absolute_nontraversing_path_required"); if (process.platform === "win32" && input.charCodeAt(0) === 92 && input.charCodeAt(1) === 92)
    throw Error("network_root_denied"); const p = path.resolve(input); if (process.platform === "win32" && p.slice(path.parse(p).root.length).split(path.sep).some(x => /[:*?"<>|]|[. ]$/.test(x)))
    throw Error("unsafe_windows_path"); let cursor = path.parse(p).root; for (const part of p.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
        throw Error('reparse_path_denied');
} if (fs.existsSync(p) && fs.realpathSync.native(p).toLowerCase() !== p.toLowerCase())
    throw Error('noncanonical_path_denied'); return p; }
const script = String.raw `
$ErrorActionPreference='Stop'
$p=$env:SINTY_ACL_ROOT; $action=$env:SINTY_ACL_ACTION
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$admins='S-1-5-32-544'; $allowed=@($sid.Value,$system.Value,$admins)
$parent=Get-Acl -LiteralPath ([IO.Path]::GetDirectoryName($p))
foreach($r in $parent.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {if($r.AccessControlType -eq 'Allow' -and -not ($r.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -and $allowed -notcontains $r.IdentityReference.Value -and ([int]$r.FileSystemRights -band 0xD0156)){throw 'untrusted_parent_write_denied'}}
$ancestor=[IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($p))
while($ancestor){$ancestorAcl=Get-Acl -LiteralPath $ancestor;foreach($r in $ancestorAcl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and -not ($r.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -and $allowed -notcontains $r.IdentityReference.Value -and ([int]$r.FileSystemRights -band 0xD0040)){throw 'untrusted_ancestor_replace_denied'}};$next=[IO.Path]::GetDirectoryName($ancestor);if($next -eq $ancestor){break};$ancestor=$next}
if($action -eq 'create'){
 if(Test-Path -LiteralPath $p){throw 'fresh_private_root_required'}
 [IO.Directory]::CreateDirectory($p)|Out-Null
 $acl=New-Object System.Security.AccessControl.DirectorySecurity
 $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
 foreach($id in @($sid,$system)){$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)|Out-Null}
 Set-Acl -LiteralPath $p -AclObject $acl
}
$a=Get-Acl -LiteralPath $p
if(-not $a.AreAccessRulesProtected -or $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'private_owner_acl_required'}
$entries=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
foreach($r in $entries){if($r.AccessControlType -ne 'Allow' -or @($sid.Value,$system.Value) -notcontains $r.IdentityReference.Value){throw 'unexpected_control_acl'}}
foreach($id in @($sid.Value,$system.Value)){if(-not ($entries|Where-Object {$_.IdentityReference.Value -eq $id -and ([int]$_.FileSystemRights -band 0x1F01FF) -eq 0x1F01FF})){throw 'missing_private_full_control'}}
$control=Join-Path $p 'control'
if(Test-Path -LiteralPath $control){$items=@(Get-Item -LiteralPath $control)+@(Get-ChildItem -LiteralPath $control -Force);if($items.Count -gt 1024){throw 'control_entries_limit'};foreach($item in $items){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'control_reparse_denied'};if($item.FullName -ne $control -and $item.PSIsContainer){throw 'unexpected_control_directory'};$ca=Get-Acl -LiteralPath $item.FullName;if($ca.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'control_owner_mismatch'};foreach($r in $ca.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -ne 'Allow' -or @($sid.Value,$system.Value) -notcontains $r.IdentityReference.Value){throw 'unexpected_control_acl'}}}}
@{protected=$true;ownerOnlyWithSystem=$true;untrustedWriteAllowed=$false;rules=$entries.Count}|ConvertTo-Json -Compress
`;
export function verifyPrivateRoot(root) { root = assertNoReparse(root); if (process.platform !== 'win32') {
    const s = fs.statSync(root);
    if ((s.mode & 0o077) !== 0 || s.uid !== process.getuid())
        throw Error('private_owner_mode_required');
    return { protected: true, ownerOnlyWithSystem: false, untrustedWriteAllowed: false };
} return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, SINTY_ACL_ROOT: root, SINTY_ACL_ACTION: 'verify' }, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })); }
export function createPrivateRoot(root) { root = assertNoReparse(root); if (fs.existsSync(root))
    throw Error('fresh_private_root_required'); assertNoReparse(path.dirname(root)); if (process.platform === 'win32')
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, SINTY_ACL_ROOT: root, SINTY_ACL_ACTION: 'create' }, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })); fs.mkdirSync(root, { mode: 0o700 }); return verifyPrivateRoot(root); }
