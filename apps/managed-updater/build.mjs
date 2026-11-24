import fs from 'node:fs';
import path from 'node:path';
import ts from '../../node_modules/typescript/lib/typescript.js';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url)), out = path.join(root, 'dist');
fs.mkdirSync(path.join(out, 'src'), { recursive: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });
for (const name of ['manager', 'runtime-host', 'worker', 'bootstrap','private-root','legacy-adoption','legacy-host','legacy-plan','recovery-cli','legacy-coordinator','legacy-resume-cli']) {
    const text = fs.readFileSync(path.join(root, 'src', name + '.mjs'), 'utf8').replaceAll('../../../packages/release-tools/harness-archive.mjs', '../vendor/harness-archive.mjs').replaceAll('../../../packages/core/src/plugin-release.ts', '../vendor/plugin-release.js');
    fs.writeFileSync(path.join(out, 'src', name + '.mjs'), text);
}
fs.copyFileSync(path.join(root, '../../packages/release-tools/harness-archive.mjs'), path.join(out, 'vendor/harness-archive.mjs'));
fs.writeFileSync(path.join(out, 'vendor/plugin-release.js'), ts.transpileModule(fs.readFileSync(path.join(root, '../../packages/core/src/plugin-release.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } }).outputText);
fs.writeFileSync(path.join(out, 'package.json'), '{"type":"module"}\n');
console.log('Built independent updater only; no service/install started');
