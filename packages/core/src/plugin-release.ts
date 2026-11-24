import { createHash, verify, createPublicKey } from "node:crypto";
export const PLUGIN_VERSION_PATTERN = "(0|[1-9][0-9]{0,14})\\.(0|[1-9][0-9]{0,14})\\.(0|[1-9][0-9]{0,14})(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?";
const versionRE = new RegExp("^" + PLUGIN_VERSION_PATTERN + "$");
export function validPluginVersion(v: string): boolean { return v.length <= 128 && versionRE.test(v) && v.split(/[.+-]/).slice(0, 3).every(x => Number.isSafeInteger(Number(x))); }
export function comparePluginVersions(a: string, b: string): number { if (!validPluginVersion(a) || !validPluginVersion(b))
    throw Error("invalid_version"); const aa = a.split("+")[0]!, bb = b.split("+")[0]!, ai = aa.indexOf("-"), bi = bb.indexOf("-"), an = (ai < 0 ? aa : aa.slice(0, ai)).split(".").map(Number), bn = (bi < 0 ? bb : bb.slice(0, bi)).split(".").map(Number); for (let i = 0; i < 3; i++)
    if (an[i] !== bn[i])
        return an[i]! < bn[i]! ? -1 : 1; if (ai < 0 || bi < 0)
    return ai === bi ? 0 : ai < 0 ? 1 : -1; const ap = aa.slice(ai + 1).split("."), bp = bb.slice(bi + 1).split("."); for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined)
        return -1;
    if (bp[i] === undefined)
        return 1;
    const x = ap[i]!, y = bp[i]!;
    if (x === y)
        continue;
    const xn = /^[0-9]+$/.test(x), yn = /^[0-9]+$/.test(y);
    if (xn && yn)
        return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn)
        return xn ? -1 : 1;
    return x < y ? -1 : 1;
} return 0; }
/** Deliberately bounded AND range, not arbitrary npm syntax: >=1.0.0 <2.0.0 or exact. */
export function validPluginRange(r: string): boolean { if (!r || r.length > 256 || r !== r.trim())
    return false; const parts = r.trim().split(/\s+/); return parts.length <= 4 && parts.every(p => { const m = /^(>=|<=|>|<|=)?(.+)$/.exec(p); return !!m && validPluginVersion(m[2]!); }); }
export function satisfiesPluginRange(v: string, r: string): boolean { if (!validPluginVersion(v) || !validPluginRange(r))
    return false; const base = v.split("-")[0]!.split("+")[0]!; if (v.split("+")[0]!.includes("-") && !r.split(/\s+/).some(p => p.replace(/^[<>=]+/, "").startsWith(base + "-")))
    return false; return r.trim().split(/\s+/).every(p => { const m = /^(>=|<=|>|<|=)?(.+)$/.exec(p)!, c = comparePluginVersions(v, m[2]!); return m[1] === ">=" ? c >= 0 : m[1] === "<=" ? c <= 0 : m[1] === ">" ? c > 0 : m[1] === "<" ? c < 0 : c === 0; }); }
export interface ReleaseCompatibility {
    core?: string;
    sdk?: string;
    protocol?: string;
    platforms?: string[];
    architectures?: string[];
}
export function assertReleaseCompatibility(c: ReleaseCompatibility | undefined, v: {
    core: string;
    sdk: string;
    protocol: string;
    platform: string;
    arch: string;
}): void { if (!c)
    return; for (const k of ["core", "sdk"] as const)
    if (c[k] && !satisfiesPluginRange(v[k], c[k]!))
        throw Object.assign(Error("Plugin incompatible with " + k), { code: "incompatible_plugin" }); if (c.protocol && c.protocol !== v.protocol || c.platforms && !c.platforms.includes(v.platform) || c.architectures && !c.architectures.includes(v.arch))
    throw Object.assign(Error("Plugin protocol/platform incompatible"), { code: "incompatible_plugin" }); }
export function inferredCategories(m: {
    categories?: readonly string[];
    kinds: readonly string[];
}): string[] { return m.categories ? [...m.categories] : [...new Set(m.kinds.map(k => k === "ui" ? "ui" : k === "tool" ? "functional" : "system"))]; }
export function canonicalJson(x: unknown): string { if (Array.isArray(x))
    return "[" + x.map(canonicalJson).join(",") + "]"; if (x && typeof x === "object")
    return "{" + Object.keys(x).sort().map(k => JSON.stringify(k) + ":" + canonicalJson((x as Record<string, unknown>)[k])).join(",") + "}"; return JSON.stringify(x) ?? "null"; }
export const releaseHash = (x: unknown): string => createHash("sha256").update(canonicalJson(x)).digest("hex");
/** Key is supplied by trusted local configuration, NEVER taken from the signed feed. No key generation here. */
export function verifyCatalogBytes(bytes: Buffer, signature: Buffer, trustedPublicKey: string): boolean { if (bytes.length > 1024 * 1024 || signature.length !== 64)
    return false; try {
    const k = createPublicKey(trustedPublicKey);
    return k.asymmetricKeyType === "ed25519" && verify(null, bytes, k, signature);
}
catch {
    return false;
} }
export function verifyPackageBytes(bytes: Buffer, expectedSha256: string, maxBytes = 64 * 1024 * 1024): boolean { return /^[a-f0-9]{64}$/.test(expectedSha256) && bytes.length <= maxBytes && createHash("sha256").update(bytes).digest("hex") === expectedSha256; }
export interface CatalogPackage {
    name: string;
    version: string;
    publisher: string;
    url: string;
    sha256: string;
    bytes: number;
}
export interface TrustedCatalog {
    format: "sinty.plugins/1";
    sequence: number;
    expires: string;
    packages: CatalogPackage[];
}
export function verifyTrustedCatalog(bytes: Buffer, signature: Buffer, anchor: string, guard: {
    testLoopbackOrigin?: string;
    now: number;
    minSequence: number;
    knownPackages?: Record<string, string>;
}): TrustedCatalog { if (!verifyCatalogBytes(bytes, signature, anchor))
    throw Error("catalog_signature_invalid"); const x = JSON.parse(bytes.toString("utf8")) as TrustedCatalog; if (!x || x.format !== "sinty.plugins/1" || !Number.isSafeInteger(x.sequence) || x.sequence < guard.minSequence || !Number.isFinite(Date.parse(x.expires)) || Date.parse(x.expires) <= guard.now || !Array.isArray(x.packages) || x.packages.length > 1000)
    throw Error("catalog_invalid_or_stale"); const seen = new Set<string>(); for (const p of x.packages) {
    if (!p || !/^[a-z][a-z0-9-]{1,63}$/.test(p.name) || !validPluginVersion(p.version) || !/^[a-zA-Z0-9_-]{1,64}$/.test(p.publisher) || !/^[a-f0-9]{64}$/.test(p.sha256) || !Number.isSafeInteger(p.bytes) || p.bytes < 1 || p.bytes > 64 * 1024 * 1024)
        throw Error("catalog_package_invalid");
    const u = new URL(p.url);
    if ((u.protocol !== "https:" && !(guard.testLoopbackOrigin && u.protocol==="http:" && u.hostname==="127.0.0.1" && !!u.port && u.origin===guard.testLoopbackOrigin)) || u.username || u.password || u.hash)
        throw Error("catalog_url_invalid");
    const k = p.name + "@" + p.version;
    if (guard.knownPackages?.[k] && guard.knownPackages[k] !== p.sha256)
        throw Error("catalog_immutable_version_changed");
    if (seen.has(k))
        throw Error("catalog_duplicate_immutable_version");
    seen.add(k);
} return x; }
