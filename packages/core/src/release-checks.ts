import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { syncJson } from './plugin-recovery.js';
import { PluginCatalogClient } from './plugin-catalog.js';
import { publicFetch } from './netguard.js';
import { verifyCatalogBytes, validPluginVersion, comparePluginVersions } from './plugin-release.js';
import type { Sinty } from './sinty.js';
export interface CheckState {
    configured: boolean;
    checking: boolean;
    lastChecked: string | null;
    lastSuccess: string | null;
    error: string | null;
    plugins: unknown[];
    harness: unknown[];
    nextCheck: string | null;
}
export class MetadataPoller {
    state: CheckState = { configured: false, checking: false, lastChecked: null, lastSuccess: null, error: null, plugins: [], harness: [], nextCheck: null };
    private timer: ReturnType<typeof setTimeout> | undefined;
    private flight: Promise<CheckState> | undefined;
    private stopped = true;
    private failures = 0;
    constructor(private probe: () => Promise<{
        configured: boolean;
        plugins: unknown[];
        harness: unknown[];
    }>, private options: {
        intervalMs?: number;
        random?: () => number;
        now?: () => number;
    } = {}) { }
    private now() { return this.options.now?.() ?? Date.now(); }
    start() { if (!this.stopped)
        return; this.stopped = false; this.schedule(Math.floor((this.options.random?.() ?? Math.random()) * 1000)); }
    stop() { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; this.state.nextCheck = null; }
    private schedule(ms: number) { clearTimeout(this.timer); if (this.stopped)
        return; this.state.nextCheck = new Date(this.now() + ms).toISOString(); this.timer = setTimeout(() => { void this.checkNow().then(() => { const base = this.failures ? Math.min(60000 * 2 ** Math.min(this.failures - 1, 8), this.options.intervalMs ?? 21600000) : (this.options.intervalMs ?? 21600000); this.schedule(base * (0.9 + (this.options.random?.() ?? Math.random()) * 0.2)); }); }, ms); this.timer.unref?.(); }
    checkNow(): Promise<CheckState> { if (this.flight)
        return this.flight; this.state.checking = true; this.flight = (async () => { try {
        const next = await this.probe();
        this.failures = 0;
        this.state = { ...this.state, ...next, lastSuccess: next.configured ? new Date(this.now()).toISOString() : null, error: null };
    }
    catch {
        this.failures++;
        this.state.error = 'update_check_failed_offline_or_untrusted';
    }
    finally {
        this.state.checking = false;
        this.state.lastChecked = new Date(this.now()).toISOString();
        this.flight = undefined;
    } return { ...this.state }; })(); return this.flight; }
}
export class ReleaseChecks extends MetadataPoller {
    constructor(s: Sinty, testing?: {
        loopbackOrigin: string;
    }) { super(async () => { const config = s.config.updates, legacy = s.config.plugins.config['plugin-catalog'] ?? {}, indexUrl = config.indexUrl ?? legacy.indexUrl, publicKey = config.publicKey ?? legacy.publicKey; if (!indexUrl && !publicKey)
        return { configured: false, plugins: [], harness: [] }; if (!config.enabled)
        return { configured: false, plugins: [], harness: [] }; if (typeof indexUrl !== 'string' || typeof publicKey !== 'string')
        throw Error('incomplete_update_source'); const u = new URL(indexUrl); if (u.protocol !== 'https:' && u.origin !== testing?.loopbackOrigin || u.username || u.password || u.search || u.hash)
        throw Error('https_required'); const guard = testing ? { allow: [{ host: '127.0.0.1', port: Number(new URL(testing.loopbackOrigin).port) }] } : {}; const fetchBytes = async (url: string, maxBytes: number) => { const r = await publicFetch(url, { maxBytes, timeoutMs: 10000, maxRedirects: 0 }, guard); if (r.status !== 200)
        throw Error('update_feed_failed'); return Buffer.from(r.body); }; const harnessUrl = new URL('/harness-index.json', u.origin).href; const [bytes, signature] = await Promise.all([fetchBytes(harnessUrl, 1024 ** 2), fetchBytes(harnessUrl + '.sig', 64)]); if (!verifyCatalogBytes(bytes, signature, publicKey))
        throw Error('release_signature_invalid'); const index = JSON.parse(bytes.toString('utf8')); if (index.format !== 'sinty.harness/1' || !Array.isArray(index.releases) || !Number.isSafeInteger(index.sequence) || !Number.isFinite(Date.parse(index.expires)) || Date.parse(index.expires) <= Date.now())
        throw Error('invalid_harness_feed'); const dir = join(s.paths.home, 'update-checks'); mkdirSync(dir, { recursive: true }); const cacheFile = join(dir, 'source.json'), keyHash = createHash('sha256').update(publicKey).digest('hex'), saved = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : { sequence: 0, keyHash, url: u.href, known: {} }; if (saved.keyHash !== keyHash || saved.url !== u.href || index.sequence < saved.sequence)
        throw Error('update_anchor_changed_or_replay'); for (const r of index.releases) {
        const id = [r.version, r.platform, r.arch, r.channel].join('/');
        if (saved.known[id] && saved.known[id] !== r.sha256)
            throw Error('immutable_release_conflict');
        saved.known[id] = r.sha256;
    } saved.sequence = index.sequence; const harness = index.releases.filter((r: any) => { if (!validPluginVersion(r.version) || !/^[a-f0-9]{64}$/.test(r.sha256) || new URL(r.url).origin !== u.origin)
        throw Error('invalid_release'); return r.platform === process.platform && r.arch === process.arch && r.channel === 'stable'; }).map((r: any) => ({ ...r, updateAvailable:!!s.managed&&comparePluginVersions(r.version,s.managed.version)>0,applySupported:!!s.managed&&comparePluginVersions(r.version,s.managed.version)>0&&r.platform==='win32'&&r.updaterProtocol===1, supportReason:s.managed?'managed':'development_checkout' })); const clone = { ...s.config, plugins: { ...s.config.plugins, config: { ...s.config.plugins.config, 'plugin-catalog': { indexUrl, publicKey } } } }; const plugins = (await new PluginCatalogClient(s.paths, clone, s.host, testing).list()).packages; syncJson(cacheFile, saved); return { configured: true, plugins, harness }; }, { intervalMs: s.config.updates.intervalHours * 3600000 }); }
}
