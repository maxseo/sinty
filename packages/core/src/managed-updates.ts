import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { publicFetch, checkPublicUrl, pinnedLookup } from './netguard.js';
import { verifyCatalogBytes } from './plugin-release.js';
import type { Sinty } from './sinty.js';
export class ManagedUpdateBridge {
    constructor(private s: Sinty, private testing?: {
        loopbackOrigin: string;
    }) { }
    status() { if (!this.s.managed)
        return Promise.resolve({ mode: 'development', applySupported: false, reason: 'Эта checkout-копия не заменяется обновлением. Для установленного режима нужен явный bootstrap с сохранением того же home.' }); return this.ipc('/status'); }
    private endpoint() { const root = this.s.managed?.root; if (!root)
        throw Error('development_checkout_not_updatable'); const digest = crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24); return { pipe: process.platform === 'win32' ? '\\\\.\\pipe\\sinty-updater-' + digest : path.join(root, 'control/updater.sock'), token: fs.readFileSync(path.join(root, 'control/owner.token'), 'utf8') }; }
    private ipc(route: string, body?: unknown): Promise<any> { const p = this.endpoint(); return new Promise((resolve, reject) => { const req = http.request({ socketPath: p.pipe, path: route, method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + p.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, timeout: 5000 }, res => { let value = ''; res.on('data', b => { value += b; if (value.length > 1024 ** 2)
        req.destroy(Error('updater_response_limit')); }); res.on('end', () => { try {
        const x = JSON.parse(value);
        if ((res.statusCode ?? 500) >= 400)
            reject(Error(typeof x.error === 'string' ? x.error : 'managed_update_failed'));
        else
            resolve(x);
    }
    catch (e) {
        reject(e);
    } }); }); req.on('error', () => reject(Error('managed_helper_unavailable'))); req.on('timeout', () => req.destroy()); if (body)
        req.write(JSON.stringify(body)); req.end(); }); }
    async review(version: string) { this.endpoint(); this.s.assertManagedLifecycle(); const legacy = this.s.config.plugins.config['plugin-catalog'] ?? {}, cfg = this.s.config.updates, indexUrl = cfg.indexUrl ?? legacy.indexUrl, key = cfg.publicKey ?? legacy.publicKey; if (typeof indexUrl !== 'string' || typeof key !== 'string')
        throw Error('update_source_not_configured'); const url = new URL(indexUrl); if (url.protocol !== 'https:' && url.origin !== this.testing?.loopbackOrigin || url.username || url.password || url.search || url.hash)
        throw Error('update_https_required'); const guard = this.testing ? { allow: [{ host: '127.0.0.1', port: Number(new URL(this.testing.loopbackOrigin).port) }] } : {}, feed = new URL('/harness-index.json', url.origin).href; const get = async (u: string, max: number) => { const r = await publicFetch(u, { maxBytes: max, maxRedirects: 0, timeoutMs: 10000 }, guard); if (r.status !== 200 || r.truncated)
        throw Error('release_feed_unavailable'); return Buffer.from(r.body); }; const [bytes, sig] = await Promise.all([get(feed, 1024 ** 2), get(feed + '.sig', 64)]); if (!verifyCatalogBytes(bytes, sig, key))
        throw Error('release_signature_invalid'); await this.ipc('/catalog', { index: bytes.toString('base64'), signature: sig.toString('base64') }); const index = JSON.parse(bytes.toString()), entry = index.releases.find((r: any) => r.version === version && r.platform === process.platform && r.arch === process.arch && r.channel === 'stable'); if (!entry || !Number.isSafeInteger(entry.bytes) || entry.bytes > 512 * 1024 ** 2 || entry.bytes < 1 || !/^[a-f0-9]{64}$/.test(entry.sha256))
        throw Error('release_not_available'); const source = new URL(entry.url); if (source.origin !== url.origin || source.pathname !== '/artifacts/' + entry.sha256 + '.tgz' || source.username || source.password || source.search || source.hash)
        throw Error('release_source_denied'); const target = await checkPublicUrl(source.href, guard); const download = await new Promise<http.IncomingMessage>((resolve, reject) => { const request = (source.protocol === 'https:' ? https : http).get(source, { lookup: pinnedLookup(target), headers: { 'Accept-Encoding': 'identity' }, timeout: 120000 }, r => { if (r.statusCode !== 200 || r.headers['content-encoding'] && r.headers['content-encoding'] !== 'identity') {
        r.destroy();
        reject(Error('release_download_denied'));
    }
    else
        resolve(r); }); request.on('error', reject); request.on('timeout', () => request.destroy(Error('release_download_timeout'))); }); const p = this.endpoint(); let received = 0; const limiter = new Transform({ transform(chunk, _, done) { received += chunk.length; if (received > entry.bytes)
            done(Error('release_size_limit'));
        else
            done(null, chunk); } }); let response: Promise<void>; const upload = http.request({ socketPath: p.pipe, path: '/artifacts/' + entry.sha256, method: 'PUT', headers: { Authorization: 'Bearer ' + p.token, 'Content-Type': 'application/octet-stream' }, timeout: 180000 }); response = new Promise((resolve, reject) => { upload.on('response', r => { r.resume(); r.on('end', () => r.statusCode === 200 ? resolve() : reject(Error('release_stage_rejected'))); }); upload.on('error', reject); upload.on('timeout', () => upload.destroy(Error('stage_timeout'))); }); await Promise.all([pipeline(download, limiter, upload), response]); if (received !== entry.bytes)
        throw Error('release_size_mismatch'); return this.ipc('/review', { version }); }
    apply(reviewId: string) { return this.ipc('/apply', { reviewId, confirm: true }); }
    recover() { return this.ipc('/recover', { confirm: true }); }
}
