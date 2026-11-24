import fs from 'node:fs';
import path from 'node:path';
import ts from '../../node_modules/typescript/lib/typescript.js';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url)), out = path.join(root, 'dist');
fs.mkdirSync(path.join(out, 'src'), { recursive: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });
for (const name of ['center', 'main']) {
    let source = fs.readFileSync(path.join(root, 'src', name + '.ts'), 'utf8').replaceAll('../../../packages/core/src/plugin-archive.ts', '../vendor/plugin-archive.js').replaceAll('../../../packages/core/src/plugin-release.ts', '../vendor/plugin-release.js').replaceAll('./center.ts', './center.js').replaceAll('../../../packages/release-tools/harness-archive.mjs','../vendor/harness-archive.mjs');
    fs.writeFileSync(path.join(out, 'src', name + '.js'), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } }).outputText);
}
for (const name of ['plugin-archive', 'plugin-release'])
    fs.writeFileSync(path.join(out, 'vendor', name + '.js'), ts.transpileModule(fs.readFileSync(path.join(root, '../../packages/core/src', name + '.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } }).outputText);
fs.cpSync(path.join(root, 'public'), path.join(out, 'public'), { recursive: true });
fs.writeFileSync(path.join(out, 'package.json'), '{"type":"module","engines":{"node":">=24"}}\n');
console.log('Built isolated distribution service; no start/deploy performed');

fs.copyFileSync(path.join(root,"../../packages/release-tools/harness-archive.mjs"),path.join(out,"vendor/harness-archive.mjs"));
