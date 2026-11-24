import { ManagedUpdater } from './manager.mjs';
const [action, root, ...rest] = process.argv.slice(2);
if (!['status', 'recover'].includes(action) || !root || action === 'recover' && (rest.length !== 1 || rest[0] !== '--confirm') || action === 'status' && rest.length)
    throw Error('Usage: status ROOT | recover ROOT --confirm; no PID/path deletion override');
try {
    const manager = new ManagedUpdater(root);
    if (action === 'recover')
        await manager.recover();
    console.log(JSON.stringify({ action, ...manager.status() }));
}
catch {
    console.error('Recovery refused: ownership, private ACL, lock or state could not be verified. No force/PID-guess override exists; preserve evidence.');
    process.exitCode = 1;
}
