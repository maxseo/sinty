import { ManagedUpdater, createUpdaterServer, updaterPipe } from './manager.mjs';
const root = process.argv[2];
if (!root)
    throw Error('Explicit managed root required');
const manager = new ManagedUpdater(root, { ...(process.env.NODE_ENV === 'test' && process.env.TEST_UPDATER_CRASH_AT ? { crashAt: process.env.TEST_UPDATER_CRASH_AT } : {}) });
const server = createUpdaterServer(manager);
server.listen(updaterPipe(root), async () => { try {
    await manager.recover();
    process.send?.({ ready: true });
}
catch {
    process.send?.({ ready: true, recoveryRequired: true });
} });
for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => { server.close(() => process.exit(0)); });
