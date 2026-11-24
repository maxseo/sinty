import { gunzipSync } from "node:zlib";
import { existsSync, mkdirSync, readdirSync, lstatSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
export class PluginArchiveError extends Error {
    readonly code = "unsafe_archive";
}
export function archivePath(raw: string): string { const p = raw.endsWith("/") ? raw.slice(0, -1) : raw; if (!p || p.length > 512 || p.includes("\\") || p.includes(":") || p.startsWith("/") || p.split("/").length > 32)
    throw new PluginArchiveError("Unsafe archive path"); for (const s of p.split("/"))
    if (!s || s === "." || s === ".." || /[. ]$/.test(s) || /[\x00-\x1f]/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))
        throw new PluginArchiveError("Unsafe archive segment"); return p.normalize("NFC"); }
export function readPluginTarGz(compressed: Buffer, limits: {
    maxExpanded?: number;
    maxCompressed?: number;
} = {}): {
    path: string;
    bytes: Buffer;
    directory: boolean;
}[] { if (compressed.length > Math.min(limits.maxCompressed ?? 64 * 1024 * 1024, 64 * 1024 * 1024))
    throw new PluginArchiveError("Compressed package too large"); let data: Buffer; try {
    data = gunzipSync(compressed, { maxOutputLength: Math.min(limits.maxExpanded ?? 256 * 1024 * 1024, 256 * 1024 * 1024) });
}
catch {
    throw new PluginArchiveError("Invalid or oversized gzip");
} ; const entries: {
    path: string;
    bytes: Buffer;
    directory: boolean;
}[] = [], seen = new Set<string>(); const str = (b: Buffer) => b.toString("utf8").split("\0")[0]!; const oct = (b: Buffer) => { const s = str(b).trim(); if (!/^[0-7]+$/.test(s))
    throw new PluginArchiveError("Invalid tar numeric field"); return parseInt(s, 8); }; let at = 0; for (; at + 512 <= data.length;) {
    const h = data.subarray(at, at + 512);
    if (h.every(x => x === 0)) {
        if (!data.subarray(at).every(x => x === 0))
            throw new PluginArchiveError("Unexpected trailing archive");
        return entries;
    }
    const checksum = oct(h.subarray(148, 156));
    let sum = 0;
    for (let i = 0; i < 512; i++)
        sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (sum !== checksum)
        throw new PluginArchiveError("Tar checksum mismatch");
    const type = h[156]!, directory = type === 53;
    if (type !== 0 && type !== 48 && !directory)
        throw new PluginArchiveError("Links and extended tar entries are not supported");
    const size = oct(h.subarray(124, 136));
    if (directory && size !== 0 || size > 64 * 1024 * 1024 || at + 512 + size > data.length)
        throw new PluginArchiveError("Invalid tar entry size");
    const prefix = str(h.subarray(345, 500)), p = archivePath((prefix ? prefix + "/" : "") + str(h.subarray(0, 100))), key = p.toLowerCase();
    if (seen.has(key) || entries.length >= 20000)
        throw new PluginArchiveError("Duplicate archive path or too many files");
    seen.add(key);
    entries.push({ path: p, bytes: data.subarray(at + 512, at + 512 + size), directory });
    at += 512 + Math.ceil(size / 512) * 512;
} throw new PluginArchiveError("Truncated archive"); }
export function extractPluginArchive(bytes: Buffer, dest: string): void { const entries = readPluginTarGz(bytes); if (existsSync(dest) && (lstatSync(dest).isSymbolicLink() || readdirSync(dest).length))
    throw new PluginArchiveError("Extraction target must be fresh"); mkdirSync(dest, { recursive: true, mode: 0o700 }); for (const e of entries) {
    const p = join(dest, ...e.path.split("/"));
    if (e.directory)
        mkdirSync(p, { recursive: true, mode: 0o700 });
    else {
        mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
        writeFileSync(p, e.bytes, { flag: "wx", mode: 0o600 });
    }
} }
