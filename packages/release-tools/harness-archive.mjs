import { createReadStream, createWriteStream } from 'node:fs';
import { stat, mkdir, open } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { join, dirname } from 'node:path';
import { once } from 'node:events';
export function safePath(p) { if (p.endsWith('/'))
    p = p.slice(0, -1); if (!p || p.length > 512 || p.includes('\\') || p.includes(':') || p.startsWith('/') || p.split('/').length > 32)
    throw Error('unsafe_archive_path'); for (const s of p.split('/'))
    if (!s || s === '.' || s === '..' || /[. ]$/.test(s) || /[\x00-\x1f]/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))
        throw Error('unsafe_archive_segment'); return p.normalize('NFC'); }
export async function inspectHarnessArchive(file, { destination, maxCompressed = 512 * 1024 ** 2, maxExpanded = 2 * 1024 ** 3, maxEntries = 100000 } = {}) { if ((await stat(file)).size > maxCompressed)
    throw Error('compressed_limit'); if (destination)
    await mkdir(destination, { recursive: false, mode: 0o700 }); const source = createReadStream(file), gzip = createGunzip(), stream = source.pipe(gzip), iterator = stream[Symbol.asyncIterator](); let pending = Buffer.alloc(0), expanded = 0, ended = false; const files = new Set(), seen = new Set(); let metadata, changes = ''; async function take(n, optional = false) { const parts = []; let length = 0; while (length < n) {
    if (!pending.length) {
        const x = await iterator.next();
        if (x.done) {
            if (optional && !length)
                return null;
            throw Error('truncated_archive');
        }
        pending = x.value;
        expanded += pending.length;
        if (expanded > maxExpanded)
            throw Error('expanded_limit');
    }
    const count = Math.min(n - length, pending.length);
    parts.push(pending.subarray(0, count));
    pending = pending.subarray(count);
    length += count;
} return Buffer.concat(parts, n); } const number = b => { const s = b.toString().split('\0')[0].trim(); if (!/^[0-7]+$/.test(s))
    throw Error('bad_tar_number'); const n = parseInt(s, 8); if (!Number.isSafeInteger(n) || n < 0)
    throw Error('bad_tar_number'); return n; }; try {
    for (let count = 0;; count++) {
        const h = await take(512, true);
        if (!h)
            throw Error('missing_tar_end');
        if (h.every(x => x === 0)) {
            const end = await take(512);
            if (!end.every(x => x === 0))
                throw Error('bad_tar_end');
            ended = true;
            break;
        }
        if (count >= maxEntries)
            throw Error('entries_limit');
        const expected = number(h.subarray(148, 156)), copy = Buffer.from(h);
        copy.fill(32, 148, 156);
        if (copy.reduce((a, b) => a + b, 0) !== expected || h.subarray(257, 263).toString() !== 'ustar\0' || !h.subarray(345, 500).every(x => x === 0))
            throw Error('unsupported_ustar_header');
        const raw = h.subarray(0, 100).toString('utf8').split('\0')[0], p = safePath(raw), directory = h[156] === 53;
        if (h[156] !== 0 && h[156] !== 48 && !directory)
            throw Error('links_or_special_files_forbidden');
        if (!(p === 'harness' && directory) && !p.startsWith('harness/'))
            throw Error('harness_root_required');
        const identity = p.toLowerCase();
        if (seen.has(identity))
            throw Error('duplicate_archive_path');
        seen.add(identity);
        const size = number(h.subarray(124, 136));
        if (size > maxExpanded || directory && size)
            throw Error('entry_limit');
        if (/(^|\/)(\.env(?:\..*)?|\.npmrc|\.git-credentials)$|\.(pem|key|pfx)$/i.test(p))
            throw Error('sensitive_archive_file');
        const rel = p.slice(8), target = destination && rel ? join(destination, rel) : undefined;
        let fd;
        if (directory) {
            if (target)
                await mkdir(target, { recursive: true, mode: 0o700 });
        }
        else {
            files.add(rel);
            if (target) {
                await mkdir(dirname(target), { recursive: true, mode: 0o700 });
                fd = await open(target, 'wx', 0o600);
            }
        }
        const capture = p === 'harness/release.json' || p === 'harness/CHANGELOG.md', parts = [];
        if (capture && size > 65536)
            throw Error('metadata_limit');
        let left = size, tail = '';
        try {
            while (left) {
                const b = await take(Math.min(left, 65536));
                left -= b.length;
                if (capture)
                    parts.push(b);
                const scan = tail + b.toString('latin1');
                if (/-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----/.test(scan))
                    throw Error('private_key_material');
                tail = scan.slice(-100);
                if (fd)
                    await fd.write(b);
            }
            if (fd)
                await fd.sync();
        }
        finally {
            await fd?.close();
        }
        if (capture) {
            const value = Buffer.concat(parts).toString('utf8');
            if (p.endsWith('release.json'))
                metadata = JSON.parse(value);
            else
                changes = value;
        }
        const padding = (512 - size % 512) % 512;
        if (padding && !((await take(padding)).every(x => x === 0)))
            throw Error('bad_padding');
    }
    for (;;) {
        const b = await take(512, true);
        if (!b)
            break;
        if (!b.every(x => x === 0))
            throw Error('trailing_archive_content');
    }
    if (!ended || !metadata || typeof metadata !== 'object' || Array.isArray(metadata))
        throw Error('release_manifest_required');
    if (metadata.changelog !== undefined && metadata.changelog !== 'CHANGELOG.md')
        throw Error('fixed_changelog_path_required');
    if (changes.length > 32768)
        throw Error('changelog_limit');
    return { manifest: metadata, changelog: changes, files };
}
finally {
    source.destroy();
    gzip.destroy();
} }
export async function fileDigest(file) { const { createHash } = await import('node:crypto'); const h = createHash('sha256'); for await (const b of createReadStream(file))
    h.update(b); return h.digest('hex'); }
export async function receiveToFile(input, file, max) { const { createHash } = await import('node:crypto'); const fd = await open(file, 'wx', 0o600), hash = createHash('sha256'); let bytes = 0; try {
    for await (const chunk of input) {
        const b = Buffer.from(chunk);
        bytes += b.length;
        if (bytes > max)
            throw Error('upload_limit');
        hash.update(b);
        await fd.write(b);
    }
    await fd.sync();
    return { bytes, sha256: hash.digest('hex') };
}
finally {
    await fd.close();
} }
