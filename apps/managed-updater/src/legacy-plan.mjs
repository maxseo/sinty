import { inspectLegacyAdoption } from './legacy-adoption.mjs';
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
    if (!['--home', '--install-root'].includes(args[i]) || !args[i + 1])
        throw Error('Read-only usage: --home PATH --install-root PATH; execution is intentionally unavailable');
    options[args[i] === '--home' ? 'home' : 'installRoot'] = args[i + 1];
}
if (!options.home || !options.installRoot)
    throw Error('--home and --install-root required');
console.log(JSON.stringify({ dryRun: true, ...inspectLegacyAdoption(options) }, null, 2));
