import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { publicFetch } from "./netguard.js";
import { verifyTrustedCatalog, verifyPackageBytes, assertReleaseCompatibility, comparePluginVersions, releaseHash, type ReleaseCompatibility, type CatalogPackage } from "./plugin-release.js";
import { extractPluginArchive } from "./plugin-archive.js";
import { parseManifest } from "./host/manifest.js";
import { installHomePlugin } from "./plugin-install.js";
import { packageFingerprint, syncJson } from "./plugin-recovery.js";
import { issueCatalogProof } from "./plugin-catalog-trust.js";
import type { SintyPaths } from "./paths.js";
import type { SintyConfig } from "./config.js";
import type { PluginHost } from "./host/host.js";
export class PluginCatalogClient {
    private flight: Promise<CatalogPackage[]> | undefined;
    private reviews = new Map<string, {
        name: string;
        version: string;
        sha256: string;
        manifestHash: string;
        installedHash: string;
        from: string;
        to: string;
        expires: number;
    }>();
    constructor(private paths: SintyPaths, private config: SintyConfig, private host: PluginHost, private testing?: {
        loopbackOrigin: string;
    }) { if (testing && !/^http:\/\/127\.0\.0\.1:\d+$/.test(testing.loopbackOrigin))
        throw Error("invalid_test_origin"); }
    private settings() { const legacy=this.config.plugins.config["plugin-catalog"]??{};const x={indexUrl:this.config.updates?.indexUrl??legacy.indexUrl,publicKey:this.config.updates?.publicKey??legacy.publicKey}; if (!x.indexUrl && !x.publicKey)
        return undefined; if (typeof x.indexUrl !== "string" || typeof x.publicKey !== "string")
        throw Error("catalog_config_incomplete"); const u = new URL(x.indexUrl); if ((u.protocol !== "https:" && u.origin !== this.testing?.loopbackOrigin) || u.username || u.password || u.hash || u.search)
        throw Error("catalog_https_required"); return { url: u.href, key: x.publicKey, origin: u.origin }; }
    get configured() { return !!this.settings(); }
    private async fetch(url: string, max: number): Promise<Buffer> { const s = this.settings(); if (!s || new URL(url).origin !== s.origin)
        throw Error("catalog_origin_denied"); const r = await publicFetch(url, { method: "GET", maxBytes: max, maxRedirects: 0, timeoutMs: 20000 }, this.testing ? { allow: [{ host: "127.0.0.1", port: Number(new URL(this.testing.loopbackOrigin).port) }] } : {}); if (r.status !== 200 || r.truncated)
        throw Error("catalog_download_failed"); return Buffer.from(r.body); }
    private async load(): Promise<CatalogPackage[]> { const s = this.settings(); if (!s)
        return []; const dir = join(this.paths.home, "plugin-catalog"); if (existsSync(dir) && lstatSync(dir).isSymbolicLink())
        throw Error("unsafe_catalog_state"); mkdirSync(dir, { recursive: true }); const file = join(dir, "state.json"), keyHash = createHash("sha256").update(s.key).digest("hex"); const state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as {
        keyHash: string;
        url: string;
        sequence: number;
        known: Record<string, string>;
    } : { keyHash, url: s.url, sequence: 0, known: {} }; if (state.keyHash !== keyHash || state.url !== s.url)
        throw Error("catalog_anchor_changed_review_required"); const [bytes, sig] = await Promise.all([this.fetch(s.url, 1024 * 1024), this.fetch(s.url + ".sig", 64)]); const index = verifyTrustedCatalog(bytes, sig, s.key, { now: Date.now(), minSequence: state.sequence, knownPackages: state.known, ...(this.testing ? { testLoopbackOrigin: this.testing.loopbackOrigin } : {}) }); for (const p of index.packages) {
        if (new URL(p.url).origin !== s.origin || p.bytes > 20000000)
            throw Error("catalog_package_origin_or_size_denied");
        state.known[p.name + "@" + p.version] = p.sha256;
    } if (Object.keys(state.known).length > 10000)
        throw Error("catalog_inventory_limit"); state.sequence = index.sequence; syncJson(file, state); return index.packages; }
    private packages() { if (!this.flight)
        this.flight = this.load().finally(() => { this.flight = undefined; }); return this.flight; }
    private installed(name: string) { try {
        return this.host.locate(name).manifest as ReturnType<typeof parseManifest>&{updateMode?:"rpc-only"|"restart"};
    }
    catch {
        return undefined;
    } }
    async list() { const entries = await this.packages(); return { configured: this.configured, packages: entries.map(e => { const old = this.installed(e.name); return { ...e, installedVersion: old?.version ?? null, updateAvailable: !!old && comparePluginVersions(e.version, old.version) > 0, bundled: existsSync(join(this.paths.bundledPlugins, e.name, "sinty.plugin.json")) }; }) }; }
    private async unpack(name: string, version: string) { const entry = (await this.packages()).find(e => e.name === name && e.version === version); if (!entry)
        throw Error("catalog_package_not_found"); const bytes = await this.fetch(entry.url, entry.bytes); if (bytes.length !== entry.bytes || !verifyPackageBytes(bytes, entry.sha256, 20000000))
        throw Error("catalog_package_tampered"); const temp = mkdtempSync(join(tmpdir(), "sinty-signed-plugin-")); try {
        extractPluginArchive(bytes, join(temp, "extract"));
        const dir = join(temp, "extract", "package"), manifest = parseManifest(JSON.parse(readFileSync(join(dir, "sinty.plugin.json"), "utf8"))) as ReturnType<typeof parseManifest> & {
            compatibility?: ReleaseCompatibility;
            updateMode?: "rpc-only" | "restart";
            changelog?: string;
            categories?: string[];
        };
        if (manifest.name !== entry.name || manifest.version !== entry.version)
            throw Error("catalog_manifest_identity_mismatch");
        return { entry, manifest, dir, temp };
    }
    catch (e) {
        rmSync(temp, { recursive: true, force: true });
        throw e;
    } }
    async review(name: string, version: string) { const f = await this.unpack(name, version); try {
        const old = this.installed(name), from = releaseHash(old?.permissions ?? {}), to = releaseHash(f.manifest.permissions), reviewId = randomUUID(), installedHash = releaseHash(old ?? null);
        if (old && comparePluginVersions(version, old.version) <= 0)
            throw Error("catalog_downgrade_or_same_version_denied");
        if (existsSync(join(this.paths.bundledPlugins, name, "sinty.plugin.json")))
            throw Error("bundled_requires_harness_update");
        let compatible = true, compatibilityError: string | null = null;
        try {
            assertReleaseCompatibility(f.manifest.compatibility, { core: JSON.parse(readFileSync(join(this.paths.install, "release.json"), "utf8")).version, sdk: JSON.parse(readFileSync(join(this.paths.install, "packages/sdk/package.json"), "utf8")).version, protocol: "sinty/1.0", platform: process.platform, arch: process.arch });
        }
        catch {
            compatible = false;
            compatibilityError = "incompatible_plugin";
        }
        const restartRequired = !!old && this.host.plugins.has(name) && (old.updateMode !== "rpc-only" || (this.host.plugins.get(name)?.loaded.manifest as {updateMode?:string}|undefined)?.updateMode !== "rpc-only" || f.manifest.updateMode !== "rpc-only");
        let changelog = "";
        if (f.manifest.changelog) {
            const p = join(f.dir, f.manifest.changelog);
            if (lstatSync(p).size > 256 * 1024)
                throw Error("changelog_limit");
            changelog = readFileSync(p, "utf8").slice(0, 8192);
        }
        this.reviews.set(reviewId, { name, version, sha256: f.entry.sha256, manifestHash: releaseHash(f.manifest), installedHash, from, to, expires: Date.now() + 600000 });
        for (const [id, r] of this.reviews)
            if (r.expires < Date.now())
                this.reviews.delete(id);
        return { reviewId, ...f.entry, compatible, compatibilityError, restartRequired, installedVersion: old?.version ?? null, changelog, compatibility: f.manifest.compatibility ?? null, permissionsBefore: old?.permissions ?? {}, permissionsAfter: f.manifest.permissions, permissionsChanged: from !== to, categories: f.manifest.categories ?? [], updateMode: restartRequired ? "restart-required" : "rpc-drained", requiresOwnerConfirmation: true };
    }
    finally {
        rmSync(f.temp, { recursive: true, force: true });
    } }
    async install(reviewId: string, confirm: boolean) { const r = this.reviews.get(reviewId); if (!r || r.expires < Date.now() || confirm !== true)
        throw Error("catalog_review_required"); this.reviews.delete(reviewId); const f = await this.unpack(r.name, r.version); try {
        if (f.entry.sha256 !== r.sha256 || releaseHash(f.manifest) !== r.manifestHash || releaseHash(this.installed(r.name) ?? null) !== r.installedHash)
            throw Error("catalog_review_stale");
        if (this.host.plugins.has(r.name) && (this.installed(r.name)?.updateMode !== "rpc-only" || (this.host.plugins.get(r.name)?.loaded.manifest as {updateMode?:string}|undefined)?.updateMode !== "rpc-only" || f.manifest.updateMode !== "rpc-only"))
            throw Error("plugin_restart_required");
        const proof = issueCatalogProof({ dir: f.dir, treeHash: packageFingerprint(f.dir), name: r.name, version: r.version, artifactSha256: f.entry.sha256, publisher: f.entry.publisher, catalogUrl: this.settings()!.url, catalogSequence: JSON.parse(readFileSync(join(this.paths.home, "plugin-catalog", "state.json"), "utf8")).sequence });
        return await installHomePlugin(this.paths, this.config, this.host, { path: f.dir, replace: !!this.installed(r.name), permissionsReview: { from: r.from, to: r.to } }, proof);
    }
    finally {
        rmSync(f.temp, { recursive: true, force: true });
    } }
}
