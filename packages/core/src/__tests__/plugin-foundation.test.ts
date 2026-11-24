import {findPlugin} from "../host/manifest.js";
import {resolvePaths} from "../paths.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { validPluginVersion, comparePluginVersions, validPluginRange, satisfiesPluginRange, inferredCategories, assertReleaseCompatibility, verifyCatalogBytes, verifyTrustedCatalog, verifyPackageBytes } from "../plugin-release.js";
import { archivePath, readPluginTarGz, extractPluginArchive } from "../plugin-archive.js";
import { parseManifest } from "../host/manifest.js";
const root = new URL("../../../../", import.meta.url), base = { name: "release-test", version: "1.2.3", description: "synthetic", kinds: ["tool"], runtime: "node", entry: "index.js", permissions: {} };
export function tar(entries: {
    name: string;
    type?: string;
    data?: string;
    size?: number;
}[]): Buffer { const blocks: Buffer[] = []; for (const e of entries) {
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100);
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    const data = Buffer.from(e.data ?? "");
    h.write((e.size ?? data.length).toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.fill(32, 148, 156);
    h.write(e.type ?? "0", 156);
    h.write("ustar\0", 257);
    let sum = 0;
    for (const b of h)
        sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
} blocks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(blocks)); }
test("strict SemVer rejects leading-zero prereleases and accepts independent SDK/core/build versions", () => { for (const v of ["0.0.1", "0.5.1", "1.2.3-alpha.1", "1.2.3+build.1"])
    assert.ok(validPluginVersion(v), v); for (const v of ["01.2.3", "1.2", "1.2.3-01", "1.2.3-", "v1.2.3"])
    assert.ok(!validPluginVersion(v), v); assert.equal(comparePluginVersions("1.2.3-alpha.2", "1.2.3-alpha.10"), -1); assert.equal(comparePluginVersions("1.2.3", "1.2.3-beta"), 1); });
test("bounded compatibility is fail-closed and does not conflate SDK with core", () => { assert.ok(validPluginRange(">=0.0.1 <0.1.0")); assert.ok(satisfiesPluginRange("0.0.1", ">=0.0.1 <0.1.0")); for (const r of ["^1.0.0", "*", "1.0.0 || 2.0.0", ""])
    assert.ok(!validPluginRange(r)); assert.ok(!satisfiesPluginRange("1.0.0-beta", ">=0.9.0 <2.0.0")); assert.throws(() => assertReleaseCompatibility({ sdk: ">=0.5.1" }, { core: "0.5.1", sdk: "0.0.1", protocol: "sinty/1.0", platform: "win32", arch: "x64" }), { code: "incompatible_plugin" }); });
test("old manifests remain valid; descriptive categories never change permissions", () => { assert.deepEqual(parseManifest(base).permissions, {}); const m = parseManifest({ ...base, categories: ["system", "ui"], compatibility: { core: ">=0.5.1 <0.6.0", sdk: "0.0.1" }, changelog: "CHANGELOG.md" }); assert.deepEqual(m.permissions, {}); assert.deepEqual(inferredCategories(base), ["functional"]); assert.throws(() => parseManifest({ ...base, categories: ["system", "system"] })); assert.throws(() => parseManifest({ ...base, compatibility: { core: "*" } })); assert.throws(() => parseManifest({ ...base, changelog: "../private" })); });
test("all current source plugin manifests validate without mass version rewrites", () => { const plugins = new URL("plugins/", root); let n = 0; for (const name of readdirSync(plugins)) {
    const p = new URL(name + "/sinty.plugin.json", plugins);
    if (existsSync(p)) {
        parseManifest(JSON.parse(readFileSync(p, "utf8")));
        n++;
    }
} assert.ok(n >= 37); });
const keys = generateKeyPairSync("ed25519"), anchor = keys.publicKey.export({ type: "spki", format: "pem" }).toString(), other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const payload = Buffer.from("synthetic-package"), digest = createHash("sha256").update(payload).digest("hex"), row = { name: "release-test", version: "1.0.0", publisher: "fixture", url: "https://example.com/plugin.tgz", sha256: digest, bytes: payload.length };
const index = (packages: any[] = [row], extra: any = {}) => Buffer.from(JSON.stringify({ format: "sinty.plugins/1", sequence: 2, expires: "2030-01-01T00:00:00Z", packages, ...extra }));
test("catalog signature requires external trusted anchor; feed key cannot mint trust", () => { const b = index(), sig = sign(null, b, keys.privateKey); assert.ok(verifyCatalogBytes(b, sig, anchor)); assert.ok(!verifyCatalogBytes(b, sig, other)); assert.ok(!verifyCatalogBytes(Buffer.concat([b, Buffer.from(" ")]), sig, anchor)); assert.ok(!verifyCatalogBytes(b, Buffer.alloc(3), anchor)); });
test("signed catalog enforces expiry sequence immutable hashes and unique versions", () => { const guard = { now: Date.parse("2026-11-19T00:00:00Z"), minSequence: 1 }; for (const b of [index([row, row]), index([row], { sequence: 0 }), index([row], { expires: "2020-01-01" }), index([{ ...row, url: "https://user:secret@example.com/a" }])])
    assert.throws(() => verifyTrustedCatalog(b, sign(null, b, keys.privateKey), anchor, guard)); const b = index(); assert.equal(verifyTrustedCatalog(b, sign(null, b, keys.privateKey), anchor, guard).packages.length, 1); assert.throws(() => verifyTrustedCatalog(b, sign(null, b, keys.privateKey), anchor, { ...guard, knownPackages: { "release-test@1.0.0": "0".repeat(64) } }), /immutable/); });
test("package digest and byte budget reject tampered artifacts", () => { assert.ok(verifyPackageBytes(payload, digest)); assert.ok(!verifyPackageBytes(Buffer.from("changed"), digest)); assert.ok(!verifyPackageBytes(payload, digest, 1)); });
test("archive paths reject traversal Windows ADS devices and excessive depth", () => { for (const p of ["../x", "/abs", "C:/x", "a\\b", "a/../b", "a:ads", "NUL.txt", "a./b", "a//b", Array(34).fill("a").join("/")])
    assert.throws(() => archivePath(p), p); });
test("archive rejects symlinks hardlinks extended headers and case-colliding entries", () => { for (const type of ["1", "2", "x", "g"])
    assert.throws(() => readPluginTarGz(tar([{ name: "package/link", type }]))); assert.throws(() => readPluginTarGz(tar([{ name: "package/A", data: "1" }, { name: "package/a", data: "2" }]))); });
test("archive rejects bombs invalid checksums and overlarge claimed files before extraction", () => { assert.throws(() => readPluginTarGz(gzipSync(Buffer.alloc(8192)), { maxExpanded: 1024 })); assert.throws(() => readPluginTarGz(tar([{ name: "package/a", size: 70 * 1024 * 1024 }]))); assert.throws(() => readPluginTarGz(Buffer.from("not gzip"))); });
test("valid bounded npm-style tar extracts only into fresh synthetic destination", () => { const root = mkdtempSync(join(tmpdir(), "plugin-archive-")); try {
    const out = join(root, "out");
    extractPluginArchive(tar([{ name: "package/sinty.plugin.json", data: JSON.stringify(base) }, { name: "package/index.js", data: "export default {}" }]), out);
    assert.equal(JSON.parse(readFileSync(join(out, "package/sinty.plugin.json"), "utf8")).name, base.name);
    assert.throws(() => extractPluginArchive(tar([{ name: "package/a" }]), out));
}
finally {
    rmSync(root, { recursive: true, force: true });
} });
test("single bump command atomically aligns manifest/package/history in an isolated developer fixture", () => { const dir = mkdtempSync(join(tmpdir(), "plugin-bump-")); try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "packages/core/src"), { recursive: true });
    mkdirSync(join(dir, "plugins/release-test"), { recursive: true });
    cpSync(new URL("scripts/plugin-version.mjs", root), join(dir, "scripts/plugin-version.mjs"));
    cpSync(new URL("packages/core/src/plugin-release.ts", root), join(dir, "packages/core/src/plugin-release.ts"));
    writeFileSync(join(dir, "plugins/release-test/sinty.plugin.json"), JSON.stringify(base));
    writeFileSync(join(dir, "plugins/release-test/package.json"), JSON.stringify({ version: base.version }));
    execFileSync(process.execPath, [join(dir, "scripts/plugin-version.mjs"), "bump", "release-test", "1.2.4", "Synthetic fix"], { stdio: "pipe" });
    assert.equal(JSON.parse(readFileSync(join(dir, "plugins/release-test/package.json"), "utf8")).version, "1.2.4");
    assert.match(readFileSync(join(dir, "plugins/release-test/CHANGELOG.md"), "utf8"), /Synthetic fix/);
}
finally {
    rmSync(dir, { recursive: true, force: true });
} });
test("JSON schema and runtime agree on new version range and changelog constraints", () => { const j = JSON.parse(readFileSync(new URL("schemas/plugin-manifest.schema.json", root), "utf8")); for (const v of ["1.0.0", "1.0.0-alpha.1", "1.0.0+build", "01.0.0", "1.0.0-01"])
    assert.equal(new RegExp(j.properties.version.pattern).test(v), validPluginVersion(v), v); for (const r of [">=0.5.1 <0.6.0", "0.0.1", "*", "^1.0.0", " >=0.5.1"])
    assert.equal(new RegExp(j.properties.compatibility.properties.core.pattern).test(r), validPluginRange(r), r); for (const p of ["../x", "a/../b", "a//b", "a/"])
    assert.equal(new RegExp(j.properties.changelog.pattern).test(p), false, p); });
test("tampered tar checksum is rejected even inside otherwise valid gzip", () => { const raw = gunzipSync(tar([{ name: "package/a", data: "synthetic" }])); raw[0] = 120; assert.throws(() => readPluginTarGz(gzipSync(raw)), /checksum/); });

test("direct host discovery enforces declared compatibility, not only installer calls",()=>{const home=mkdtempSync(join(tmpdir(),"plugin-host-compat-"));try{const paths=resolvePaths(home),dir=join(paths.plugins,"release-test");mkdirSync(dir,{recursive:true});writeFileSync(join(dir,"sinty.plugin.json"),JSON.stringify({...base,compatibility:{sdk:">=99.0.0"}}));assert.throws(()=>findPlugin(paths,"release-test",[]),{code:"incompatible_plugin"})}finally{rmSync(home,{recursive:true,force:true})}});

test("registry --out stages 36 entries without changing the live on-demand registry",()=>{const dir=mkdtempSync(join(tmpdir(),"registry-stage-")),live=new URL("registry/plugins.json",root),before=readFileSync(live);try{const out=join(dir,"registry.json");execFileSync(process.execPath,[new URL("scripts/registry.mjs",root).pathname.replace(/^\/(?:([A-Za-z]:))/,"$1"),"--out",out],{stdio:"pipe"});assert.deepEqual(readFileSync(live),before);const entries=JSON.parse(readFileSync(out,"utf8")).plugins;assert.ok(entries.some((x:any)=>x.name==="tool-browser"));assert.ok(entries.some((x:any)=>x.name==="dynamic-tools"));assert.ok(!entries.some((x:any)=>x.name==="example-echo"))}finally{rmSync(dir,{recursive:true,force:true})}});
