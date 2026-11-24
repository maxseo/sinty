import { fileURLToPath } from 'node:url';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { safePath, inspectHarnessArchive, fileDigest } from '../packages/release-tools/harness-archive.mjs';
export async function packageHarness({ dir, out, maxCompressed = 512 * 1024 ** 2 }) { dir = resolve(dir); const files = []; async function walk(root, rel = '') { for (const d of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = rel ? rel + '/' + d.name : d.name;
    safePath(p);
    const st = await fs.lstat(join(dir, p));
    if (st.isSymbolicLink() || !st.isDirectory() && !st.isFile() || st.nlink > 1 && !st.isDirectory())
        throw Error('links_and_special_files_forbidden');
    if (st.isDirectory())
        await walk(join(dir, p), p);
    else {
        if (files.length >= 100000 || st.size > 2 * 1024 ** 3)
            throw Error('package_limit');
        files.push({ p, size: st.size });
    }
} } await walk(dir); async function* tar() { let expanded = 0; for (const f of files) {
    const name = 'harness/' + f.p;
    if (Buffer.byteLength(name) > 100)
        throw Error('USTAR_name_limit');
    const h = Buffer.alloc(512), oct = (n, w) => n.toString(8).padStart(w - 1, '0') + '\0';
    h.write(name);
    h.write(oct(0o600, 8), 100);
    h.write(oct(0, 8), 108);
    h.write(oct(0, 8), 116);
    h.write(oct(f.size, 12), 124);
    h.write(oct(0, 12), 136);
    h.fill(32, 148, 156);
    h[156] = 48;
    h.write('ustar\0', 257);
    h.write('00', 263);
    h.write([...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    expanded += 512 + Math.ceil(f.size / 512) * 512;
    if (expanded > 2 * 1024 ** 3)
        throw Error('expanded_limit');
    yield h;
    for await (const chunk of createReadStream(join(dir, f.p)))
        yield chunk;
    yield Buffer.alloc((512 - f.size % 512) % 512);
} yield Buffer.alloc(1024); } await pipeline(Readable.from(tar()), createGzip({ level: 6 }), createWriteStream(out, { flags: 'wx', mode: 0o600 })); const bytes = (await fs.stat(out)).size; if (bytes > maxCompressed)
    throw Error('compressed_limit'); await inspectHarnessArchive(out, { maxCompressed }); return { bytes, sha256: await fileDigest(out) }; }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, v) => i % 2 ? a : (a.push([x.replace(/^--/, ''), v[i + 1]]), a), []));
    if (!args.dir || !args.out)
        throw Error('--dir and --out required');
    console.log(JSON.stringify(await packageHarness({ dir: args.dir, out: args.out })));
}
