import {createPrivateRoot} from './private-root.mjs';
import fs from 'node:fs';
import { bootstrapManagedInstall } from './manager.mjs';
const args = process.argv.slice(2), confirmed = args.includes('--confirm-new-managed-root');
if (!confirmed)
    throw Error('Explicit --confirm-new-managed-root required; no current installation is modified');
const values = {};
for (let i = 0; i < args.length; i++)
    if (args[i] !== '--confirm-new-managed-root') {
        if (!args[i].startsWith('--') || !args[i + 1])
            throw Error('Invalid bootstrap arguments');
        values[args[i].slice(2)] = args[++i];
    }
if (!values.root || !values.home || !values['public-key-file'] || !values.origin)
    throw Error('--root --home --public-key-file --origin required');
createPrivateRoot(values.root);
bootstrapManagedInstall(values.root, { home: values.home, publicKey: fs.readFileSync(values['public-key-file'], 'utf8'), origin: values.origin });
console.log('Initialized empty managed installation. No runtime started; no existing home migrated.');
