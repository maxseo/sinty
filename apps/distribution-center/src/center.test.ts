import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createDistributionCenter } from './center.ts';
const bootstrap = 'disposable-test-bootstrap-' + 'x'.repeat(40), password = 'disposable-test-password-123';
async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'sinty-center-test-')), keyFile = join(dir, 'fixture-key.pem');
    const keys = generateKeyPairSync('ed25519');
    writeFileSync(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const options = { dataDir: join(dir, 'data'), signingKeyFile: keyFile, publicBaseUrl: 'http://127.0.0.1:0/', bootstrapSecret: bootstrap, testHttpLoopback: true };
    let app = createDistributionCenter(options);
    async function listen() {
        await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
        return 'http://127.0.0.1:' + (app.server.address() as {
            port: number;
        }).port;
    }
    let origin = await listen(), cookie = '', csrf = '';
    async function request(path: string, opts: {
        method?: string;
        json?: unknown;
        bytes?: Buffer;
        auth?: boolean;
        headers?: Record<string, string>;
    } = {}) { const method = opts.method ?? (opts.json !== undefined || opts.bytes ? 'POST' : 'GET'), headers: Record<string, string> = { ...(method !== 'GET' ? { Origin: origin } : {}), ...(opts.auth === false ? {} : { ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }), ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.bytes ? { 'Content-Type': 'application/gzip' } : {}), ...opts.headers }; return fetch(origin + path, { method, headers, ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : opts.bytes ? { body: Uint8Array.from(opts.bytes) } : {}) }); }
    async function login(initial = false) { const r = await request(initial ? '/api/admin/bootstrap' : '/api/admin/login', { auth: false, json: { username: 'fixture_admin', password }, ...(initial ? { headers: { Authorization: 'Bearer ' + bootstrap } } : {}) }); assert.equal(r.status, initial ? 201 : 200, await r.clone().text()); cookie = r.headers.get('set-cookie')!.split(';')[0]!; csrf = (await r.json() as any).csrf; return r; }
    return { dir, keyFile, options, get app() { return app; }, get origin() { return origin; }, request, login, get cookie() { return cookie; }, get csrf() { return csrf; }, async restart() { await app.close(); app = createDistributionCenter(options); origin = await listen(); }, async close() { await app.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); } };
}
function tar(files: {
    name: string;
    body?: string;
    type?: string;
}[]) {
    const blocks: Buffer[] = [];
    for (const f of files) {
        const b = Buffer.from(f.body ?? ''), h = Buffer.alloc(512), oct = (n: number, w: number) => n.toString(8).padStart(w - 1, '0') + '\0';
        h.write(f.name, 0, 100);
        h.write(oct(0o600, 8), 100);
        h.write(oct(0, 8), 108);
        h.write(oct(0, 8), 116);
        h.write(oct(b.length, 12), 124);
        h.write(oct(0, 12), 136);
        h.fill(32, 148, 156);
        h[156] = (f.type ?? '0').charCodeAt(0);
        h.write('ustar\0', 257);
        h.write('00', 263);
        h.write([...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
        blocks.push(h, b, Buffer.alloc((512 - b.length % 512) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks));
}
const pluginManifest = (version = '1.0.0') => ({ name: 'center-fixture', version, description: 'synthetic center fixture', kinds: ['tool'], runtime: 'node', entry: 'index.js', updateMode: 'rpc-only', categories: ['functional'], changelog: 'CHANGELOG.md', permissions: {} });
async function stop(s: any) { const processes = [...s.host.plugins.values()] as any[]; await s.stop(); await Promise.all(processes.map(p => p.stopAndWait())); }
test('center admin isolation: closed bootstrap, HttpOnly session, CSRF, cross-origin, logout, login rate limit', async () => {
    const f = await fixture();
    try {
        assert.equal((await f.request('/api/admin/releases', { auth: false })).status, 401);
        assert.equal((await f.request('/api/admin/bootstrap', { auth: false, json: { username: 'fixture_admin', password } })).status, 403);
        assert.equal((await f.request('/api/admin/bootstrap', { auth: false, json: { username: 'fixture_admin', password }, headers: { Authorization: 'Bearer ' + bootstrap, Origin: 'https://attacker.invalid' } })).status, 403);
        const r = await f.login(true);
        assert.match(r.headers.get('set-cookie')!, /HttpOnly/);
        assert.match(r.headers.get('set-cookie')!, /SameSite=Strict/);
        assert.equal((await f.request('/api/admin/bootstrap', { auth: false, json: { username: 'another_admin', password }, headers: { Authorization: 'Bearer ' + bootstrap } })).status, 409);
        assert.equal((await f.request('/api/admin/logout', { json: {}, headers: { 'X-CSRF-Token': '' } })).status, 403);
        assert.equal((await f.request('/api/admin/logout', { json: {}, headers: { Origin: 'https://attacker.invalid' } })).status, 403);
        assert.equal((await f.request('/api/admin/logout', { json: {} })).status, 200);
        assert.equal((await f.request('/api/admin/session')).status, 401);
        await f.login();
        let last = 0;
        for (let i = 0; i < 10; i++)
            last = (await f.request('/api/admin/login', { auth: false, json: { username: 'fixture_admin', password: 'not-the-password' } })).status;
        assert.equal(last, 429);
        for (const route of ['/admin', '/admin/app.js', '/admin/style.css']) {
            const page = await f.request(route, { auth: false });
            assert.equal(page.status, 200);
            assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
            assert.ok((await page.text()).length > 50);
        }
    }
    finally {
        await f.close();
    }
});
test('real center E2E: admin draft/publish -> signed public catalog -> real harness v1/v2, activation rollback, hide/show and persisted restart', async () => {
    const f = await fixture(), helper: any = await import(new URL('../../../packages/core/.distribution-core-checkpoint/__tests__/helpers.js', import.meta.url).href), api: any = await import(new URL('../../../packages/core/.distribution-core-checkpoint/api/server.js', import.meta.url).href), publisher: any = await import(new URL('../../../scripts/plugin-publish.mjs', import.meta.url).href);
    const home = helper.tempHome(), source = join(f.dir, 'source'), out = join(f.dir, 'publisher');
    mkdirSync(source);
    const OFF = ['tool-web', 'tool-browser', 'tool-vision', 'tool-stt', 'skills', 'mcp-catalog', 'responsive-turn'];
    let s: any;
    try {
        await f.login(true);
        s = await helper.boot(home.home, [], { plugins: ['fake-provider', 'plugin-catalog'], config: { plugins: { disabled: OFF, config: { 'plugin-catalog': { indexUrl: f.origin + '/index.json', publicKey: f.app.publicKey } } } } });
        const receiver = api.createApp(s, { catalogLoopbackOrigin: f.origin }), headers = { Authorization: 'Bearer ' + s.secrets.get('api.token'), 'Content-Type': 'application/json' }, post = (path: string, body: unknown) => receiver.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
        assert.equal((await receiver.request('/v1/plugins/catalog', { headers: { Cookie: f.cookie } })).status, 401);
        assert.equal((await f.request('/api/admin/releases', { auth: false, headers: { Authorization: headers.Authorization } })).status, 401);
        function bundle(version: string, fail = false) { const manifest = { ...pluginManifest(version), ...(version === '2.0.0' || version === '4.0.0' ? { permissions: { fs: { read: ['$DATA'] } } } : {}) }; writeFileSync(join(source, 'sinty.plugin.json'), JSON.stringify(manifest)); writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'center-fixture', version, type: 'module' })); writeFileSync(join(source, 'CHANGELOG.md'), '# ' + version + '\nSynthetic release ' + version); writeFileSync(join(source, 'index.js'), fail ? 'import {definePlugin} from "@sinty/sdk";export default definePlugin({name:"center-fixture",setup(){throw Error("synthetic readiness failure")}})' : 'import {definePlugin,z} from "@sinty/sdk";export default definePlugin({name:"center-fixture",setup(ctx){ctx.tool({name:"center-fixture.ping",description:' + JSON.stringify(version) + ',input:z.object({}),sideEffects:"none",run:async()=>({content:' + JSON.stringify(version) + '})})}})'); const entry = publisher.publishPlugin({ dir: source, out, base: 'https://fixture.invalid/', key: f.keyFile, publisher: 'fixture', files: ['index.js', 'CHANGELOG.md'] }); return readFileSync(join(out, new URL(entry.url).pathname.split('/').pop()!)); }
        async function upload(bytes: Buffer) { const r = await f.request('/api/admin/uploads?kind=plugin', { bytes }); assert.equal(r.status, 201, await r.clone().text()); return r.json() as any; }
        async function publish(id: number) { const r = await f.request('/api/admin/releases/' + id + '/publish', { json: { confirm: true } }); assert.equal(r.status, 200, await r.clone().text()); }
        async function review(version: string) { const r = await post('/v1/plugins/catalog/review', { name: 'center-fixture', version }); assert.equal(r.status, 200, await r.clone().text()); return r.json() as any; }
        const v1 = await upload(bundle('1.0.0'));
        assert.equal((await (await f.request('/index.json', { auth: false })).json() as any).packages.length, 0);
        assert.equal((await f.request('/artifacts/' + v1.sha256 + '.tgz', { auth: false })).status, 404);
        await publish(v1.id);
        const index = Buffer.from(await (await f.request('/index.json', { auth: false })).arrayBuffer()), sig = Buffer.from(await (await f.request('/index.json.sig', { auth: false })).arrayBuffer());
        assert.equal(verify(null, index, f.app.publicKey, sig), true);
        const pkg = JSON.parse(index.toString()).packages[0], download = Buffer.from(await (await fetch(pkg.url)).arrayBuffer());
        assert.equal(createHash('sha256').update(download).digest('hex'), pkg.sha256);
        const r1 = await review('1.0.0');
        assert.equal((await post('/v1/plugins/catalog/install', { reviewId: r1.reviewId, confirm: true })).status, 201);
        assert.equal(s.host.tools().find((t: any) => t.name === 'center-fixture.ping')?.description, '1.0.0');
        mkdirSync(join(s.paths.data, 'center-fixture'), { recursive: true });
        writeFileSync(join(s.paths.data, 'center-fixture', 'keep'), 'retained fixture data');
        const v2 = await upload(bundle('2.0.0'));
        await publish(v2.id);
        const r2 = await review('2.0.0');
        assert.equal(r2.permissionsChanged, true);
        assert.notEqual((await post('/v1/plugins/catalog/install', { reviewId: r2.reviewId, confirm: false })).status, 201);
        assert.equal((await post('/v1/plugins/catalog/install', { reviewId: r2.reviewId, confirm: true })).status, 201);
        assert.equal(s.host.tools().find((t: any) => t.name === 'center-fixture.ping')?.description, '2.0.0');
        const configBefore = readFileSync(s.paths.config, 'utf8');
        const bad = await upload(bundle('4.0.0', true));
        await publish(bad.id);
        const rb = await review('4.0.0'), failed = await post('/v1/plugins/catalog/install', { reviewId: rb.reviewId, confirm: true });
        assert.equal(failed.status, 409);
        assert.match(await failed.text(), /activation_failed_rolled_back/);
        assert.equal(readFileSync(s.paths.config, 'utf8'), configBefore);
        assert.equal(readFileSync(join(s.paths.data, 'center-fixture', 'keep'), 'utf8'), 'retained fixture data');
        assert.equal(s.host.tools().find((t: any) => t.name === 'center-fixture.ping')?.description, '2.0.0');
        const hide = await f.request('/api/admin/plugins/center-fixture/visibility', { json: { visible: false, confirm: true } });
        assert.equal(hide.status, 200);
        assert.equal((await (await f.request('/index.json', { auth: false })).json() as any).packages.length, 0);
        assert.equal((await f.request('/artifacts/' + v2.sha256 + '.tgz', { auth: false })).status, 200);
        assert.equal(s.host.tools().find((t: any) => t.name === 'center-fixture.ping')?.description, '2.0.0');
        await f.restart();
        assert.equal((await (await f.request('/index.json', { auth: false })).json() as any).packages.length, 0);
        await f.login();
        assert.equal((await f.request('/api/admin/setup', { auth: false })).status, 200);
        const state = await (await f.request('/api/admin/setup', { auth: false })).json() as any;
        assert.equal(state.needed, false);
        await f.request('/api/admin/plugins/center-fixture/visibility', { json: { visible: true, confirm: true } });
        assert.equal((await (await f.request('/index.json', { auth: false })).json() as any).packages.length, 3);
        const history = await (await f.request('/api/admin/releases')).json() as any;
        assert.ok(history.events.some((x: any) => x.action === 'publish'));
        assert.ok(history.events.some((x: any) => x.action === 'plugin-hide:center-fixture'));
        await stop(s);
        s = await helper.boot(home.home, [], { plugins: ['fake-provider', 'plugin-catalog', 'center-fixture'], config: { plugins: { disabled: OFF } } });
        assert.equal(s.host.tools().find((t: any) => t.name === 'center-fixture.ping')?.description, '2.0.0');
        assert.equal(readFileSync(join(s.paths.data, 'center-fixture', 'keep'), 'utf8'), 'retained fixture data');
    }
    finally {
        if (s)
            await stop(s);
        home.cleanup();
        await f.close();
    }
});
test('harness artifact draft/publish/signature/history uses same admin, does not pretend updater exists', async () => {
    const f = await fixture();
    try {
        await f.login(true);
        const release = { version: '0.5.2', platform: 'win32', arch: 'x64', channel: 'stable', coreVersion: '0.1.0', sdkVersion: '0.1.0', changelog: 'CHANGELOG.md', dataCompatibility: 'requires-review' }, bytes = tar([{ name: 'harness/release.json', body: JSON.stringify(release) }, { name: 'harness/CHANGELOG.md', body: 'Synthetic harness release; no runnable installer' }, { name: 'harness/fixture.txt', body: 'not executable' }]);
        const r = await f.request('/api/admin/uploads?kind=harness', { bytes });
        assert.equal(r.status, 201, await r.clone().text());
        const row = await r.json() as any;
        assert.equal((await (await f.request('/harness-index.json', { auth: false })).json() as any).releases.length, 0);
        assert.equal((await f.request('/api/admin/releases/' + row.id + '/publish', { json: { confirm: false } })).status, 400);
        assert.equal((await f.request('/api/admin/releases/' + row.id + '/publish', { json: { confirm: true } })).status, 200);
        const index = Buffer.from(await (await f.request('/harness-index.json', { auth: false })).arrayBuffer()), sig = Buffer.from(await (await f.request('/harness-index.json.sig', { auth: false })).arrayBuffer());
        assert.equal(verify(null, index, f.app.publicKey, sig), true);
        const item = JSON.parse(index.toString()).releases[0];
        assert.equal(item.platform, 'win32');
        assert.equal(item.applySupported, false);
        assert.equal(item.version, '0.5.2');
        assert.equal((await f.request('/api/admin/releases/' + row.id + '/hide', { json: { confirm: true } })).status, 200);
        assert.equal((await (await f.request('/harness-index.json', { auth: false })).json() as any).releases.length, 0);
        assert.equal((await fetch(item.url)).status, 200);
    }
    finally {
        await f.close();
    }
});
test('uploads fail closed: unauthenticated, malformed archive, traversal, symlink, secret material, manifest mismatch and immutable version', async () => {
    const f = await fixture();
    try {
        assert.equal((await f.request('/api/admin/uploads?kind=plugin', { auth: false, bytes: Buffer.from('not gzip') })).status, 401);
        await f.login(true);
        const upload = (bytes: Buffer) => f.request('/api/admin/uploads?kind=plugin', { bytes });
        assert.equal((await upload(Buffer.from('invalid gzip'))).status, 400);
        for (const evil of [{ name: 'package/../escape', body: 'bad' }, { name: 'package/link', type: '2', body: '' }])
            assert.equal((await upload(tar([evil]))).status, 400);
        const m = JSON.stringify(pluginManifest()), base = [{ name: 'package/sinty.plugin.json', body: m }, { name: 'package/index.js', body: 'export default {}' }, { name: 'package/CHANGELOG.md', body: 'test' }];
        assert.equal((await upload(tar([...base, { name: 'package/.env', body: 'synthetic' }]))).status, 400);
        assert.equal((await upload(tar([...base, { name: 'package/package.json', body: JSON.stringify({ version: '9.0.0' }) }]))).status, 400);
        const ok = tar(base);
        assert.equal((await upload(ok)).status, 201);
        assert.equal((await upload(ok)).status, 200);
        assert.equal((await upload(tar([...base, { name: 'package/other.txt', body: 'different bytes' }]))).status, 409);
        const malformed = [...base];
        malformed[0] = { name: 'package/sinty.plugin.json', body: JSON.stringify({ ...pluginManifest(), version: 'not-semver' }) };
        assert.equal((await upload(tar(malformed))).status, 400);
        const missing = [...base];
        missing[0] = { name: 'package/sinty.plugin.json', body: JSON.stringify({ ...pluginManifest(), entry: undefined }) };
        assert.equal((await upload(tar(missing))).status, 400);
        assert.equal((await f.request('/artifacts/../../fixture-key.pem', { auth: false })).status, 404);
    }
    finally {
        await f.close();
    }
});
test('production configuration refuses insecure origins, keys inside data and non-Ed25519; bootstrap disabled without explicit secret', async () => {
    const f = await fixture();
    try {
        assert.throws(() => createDistributionCenter({ ...f.options, testHttpLoopback: false }), /HTTPS/);
        assert.throws(() => createDistributionCenter({ ...f.options, signingKeyFile: join(f.options.dataDir, 'key.pem') }), /outside/);
        await f.app.close();
        const app = createDistributionCenter({ ...f.options, dataDir: join(f.dir, 'closed'), bootstrapSecret: '' });
        await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
        try {
            const origin = 'http://127.0.0.1:' + (app.server.address() as {
                port: number;
            }).port;
            assert.equal((await (await fetch(origin + '/api/admin/setup')).json() as any).enabled, false);
            assert.equal((await fetch(origin + '/api/admin/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
        }
        finally {
            await app.close();
        }
    }
    finally {
        await f.close();
    }
});
test('admin UI handlers with DOM fixture and real HTTP: bootstrap -> upload draft -> explicit publish; no automatic publication', async () => {
    const f = await fixture();
    try {
        class Element {
            children: any[] = [];
            values: Record<string, unknown> = {};
            textContent = '';
            hidden = false;
            disabled = false;
            dataset: any = {};
            classList = { toggle() { } };
            onclick: any;
            onsubmit: any;
            resets = 0;
            button: any;
            append(...x: any[]) { this.children.push(...x); }
            replaceChildren(...x: any[]) { this.children = x; }
            querySelector() { return this.button ??= new Element(); }
            addEventListener() { }
            showModal() { this.hidden = false; }
            close() { this.hidden = true; }
            reset() { this.resets++; this.values = {}; }
        }
        const elements = new Map<string, Element>(), get = (s: string) => {
            let e = elements.get(s);
            if (!e) {
                e = new Element();
                elements.set(s, e);
            }
            return e;
        };
        const nav = ['plugin', 'harness', 'history'].map(filter => { const e = new Element(); e.dataset.filter = filter; return e; }), document = { querySelector: get, querySelectorAll: () => nav, createElement: () => new Element() };
        class FormDataFixture {
            values: Record<string, unknown>;
            constructor(e: Element) { this.values = { ...e.values }; }
            get(name: string) { return this.values[name]; }
        }
        let cookie = '';
        const realFetch = async (url: string, opts: any = {}) => {
            const r = await fetch(f.origin + url, { ...opts, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(opts.method ? { Origin: f.origin } : {}), ...opts.headers } });
            if (r.headers.get('set-cookie'))
                cookie = r.headers.get('set-cookie')!.split(';')[0]!;
            return r;
        };
        const AsyncFunction: any = (async () => { }).constructor;
        await new AsyncFunction('document', 'fetch', 'FormData', 'File', 'location', readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'))(document, realFetch, FormDataFixture, File, { reload() { } });
        const login = get('#login');
        login.values = { username: 'fixture_admin', password, bootstrap };
        let event: any = { currentTarget: login, preventDefault() { } };
        const logging = login.onsubmit(event);
        event.currentTarget = null;
        await logging;
        assert.equal(login.resets, 1);
        assert.equal(get('#auth').hidden, true);
        assert.equal(get('#error').textContent, '');
        const bytes = tar([{ name: 'package/sinty.plugin.json', body: JSON.stringify(pluginManifest()) }, { name: 'package/index.js', body: 'export default {}' }, { name: 'package/CHANGELOG.md', body: 'Synthetic UI fixture changelog' }]), upload = get('#upload');
        upload.values = { artifact: new File([new Uint8Array(bytes)], 'fixture.tgz', { type: 'application/gzip' }) };
        event = { currentTarget: upload, preventDefault() { } };
        const uploading = upload.onsubmit(event);
        event.currentTarget = null;
        await uploading;
        assert.equal(upload.resets, 1);
        assert.equal(get('#error').textContent, '');
        assert.equal((await (await fetch(f.origin + '/index.json')).json() as any).packages.length, 0);
        const flatten = (e: Element): Element[] => [e, ...e.children.flatMap(flatten)], button = flatten(get('#releases')).find(e => e.textContent === 'Опубликовать');
        assert.ok(button);
        button.onclick();
        assert.match(get('#review-text').textContent, /Synthetic UI fixture changelog/);
        assert.equal((await (await fetch(f.origin + '/index.json')).json() as any).packages.length, 0);
        await get('#confirm').onclick();
        assert.equal(get('#error').textContent, '');
        assert.equal((await (await fetch(f.origin + '/index.json')).json() as any).packages.length, 1);
    }
    finally {
        await f.close();
    }
});
test('built standalone bundle serves admin assets and signed indexes without core dist or node_modules runtime dependencies', async () => { const f = await fixture(); let built: any; try {
    await f.app.close();
    const module: any = await import(new URL('../dist/src/center.js', import.meta.url).href);
    built = module.createDistributionCenter({ ...f.options, dataDir: join(f.dir, 'built-data') });
    await new Promise<void>(r => built.server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + built.server.address().port;
    for (const path of ['/health', '/admin', '/admin/app.js', '/admin/style.css'])
        assert.equal((await fetch(origin + path)).status, 200);
    const bytes = Buffer.from(await (await fetch(origin + '/index.json')).arrayBuffer()), sig = Buffer.from(await (await fetch(origin + '/index.json.sig')).arrayBuffer());
    assert.equal(verify(null, bytes, built.publicKey, sig), true);
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const badKey = join(f.dir, 'ephemeral-ec.pem');
    writeFileSync(badKey, ec.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    assert.throws(() => module.createDistributionCenter({ ...f.options, dataDir: join(f.dir, 'bad-key-data'), signingKeyFile: badKey }), /Ed25519/);
}
finally {
    if (built)
        await built.close();
    await f.close();
} });

test('streamed real artifact above20MB: admin publish -> public signed feed -> external updater verified install, no full artifact buffering',async()=>{const f=await fixture();let manager:any;try{await f.login(true);const fs=await import('node:fs'),crypto=await import('node:crypto'),stream=await import('node:stream'),pack:any=await import(new URL('../../../scripts/harness-package.mjs',import.meta.url).href),updater:any=await import(new URL('../../managed-updater/src/manager.mjs',import.meta.url).href);const source=join(f.dir,'large-source');mkdirSync(join(source,'app'),{recursive:true});writeFileSync(join(source,'release.json'),JSON.stringify({version:'0.5.3',platform:process.platform,arch:process.arch,channel:'stable',coreVersion:'0.1.0',sdkVersion:'0.1.0',updaterProtocol:1,nodeRange:'>=24.0.0',dataSchema:'stream-fixture',dataCompatibility:'unchanged',migrations:'none',changelog:'CHANGELOG.md'}));writeFileSync(join(source,'CHANGELOG.md'),'Large streaming fixture');writeFileSync(join(source,'app','managed-main.mjs'),'export async function startManaged(){return{health:async()=>true,stop:async()=>{}}}');const fd=fs.openSync(join(source,'app','payload.bin'),'wx');try{for(let i=0;i<340;i++)fs.writeSync(fd,crypto.randomBytes(65536))}finally{fs.closeSync(fd)}const artifact=join(f.dir,'large.tgz'),info=await pack.packageHarness({dir:source,out:artifact});assert.ok(info.bytes>20000000);const uploaded=await fetch(f.origin+'/api/admin/uploads?kind=harness',{method:'POST',headers:{Origin:f.origin,Cookie:f.cookie,'X-CSRF-Token':f.csrf,'Content-Type':'application/gzip'},body:fs.createReadStream(artifact),duplex:'half'} as any);assert.equal(uploaded.status,201,await uploaded.clone().text());const row=await uploaded.json() as any;assert.equal((await f.request('/api/admin/releases/'+row.id+'/publish',{json:{confirm:true}})).status,200);const index=Buffer.from(await(await fetch(f.origin+'/harness-index.json')).arrayBuffer()),sig=Buffer.from(await(await fetch(f.origin+'/harness-index.json.sig')).arrayBuffer());const root=join(f.dir,'managed-install'),home=join(f.dir,'managed-home');updater.bootstrapManagedInstall(root,{home,publicKey:f.app.publicKey,origin:f.origin+'/',testLoopback:true,dataSchema:'stream-fixture'});manager=new updater.ManagedUpdater(root,{healthTimeoutMs:3000});manager.acceptCatalog(index,sig);const entry=JSON.parse(index.toString()).releases[0],download=await fetch(entry.url);await manager.receiveArtifact(entry.sha256,stream.Readable.fromWeb(download.body as any));const review=await manager.review('0.5.3');assert.match(review.changelog,/Large streaming/);assert.equal((await manager.apply(review.reviewId,true)).updated,true);assert.equal(manager.status().current,'0.5.3')}finally{if(manager)await manager.stop();await f.close()}});

test('authenticated owner password change: session + CSRF, bounded secret, old login rejected, other sessions revoked, current session and drafts survive restart',async()=>{const f=await fixture();try{await f.login(true);const oldCookie=f.cookie,oldCsrf=f.csrf;await f.login();const next='another-disposable-test-password-456';const artifact=tar([{name:'package/sinty.plugin.json',body:JSON.stringify(pluginManifest())},{name:'package/package.json',body:JSON.stringify({name:'center-fixture',version:'1.0.0'})},{name:'package/index.js',body:'export default {}'},{name:'package/CHANGELOG.md',body:'Synthetic fixture only'}]);const uploaded=await f.request('/api/admin/uploads?kind=plugin',{bytes:artifact});assert.equal(uploaded.status,201);const before=await(await f.request('/api/admin/releases')).json();assert.equal((await f.request('/api/admin/password',{auth:false,json:{password:next}})).status,401);assert.equal((await f.request('/api/admin/password',{json:{password:next},headers:{'X-CSRF-Token':''}})).status,403);assert.equal((await f.request('/api/admin/password',{json:{password:next},headers:{Origin:'https://attacker.invalid'}})).status,403);for(const bad of ['too-short','x'.repeat(129),null,123])assert.equal((await f.request('/api/admin/password',{json:{password:bad}})).status,400);assert.equal((await f.request('/api/admin/password',{json:{password:next,username:'not-the-admin'}})).status,400);const changed=await f.request('/api/admin/password',{json:{password:next}});assert.equal(changed.status,200);assert.deepEqual(await changed.json(),{changed:true,otherSessionsRevoked:true});assert.equal((await f.request('/api/admin/session')).status,200);assert.equal((await f.request('/api/admin/session',{headers:{Cookie:oldCookie,'X-CSRF-Token':oldCsrf}})).status,401);assert.equal((await f.request('/api/admin/login',{auth:false,json:{username:'fixture_admin',password}})).status,401);assert.equal((await f.request('/api/admin/login',{auth:false,json:{username:'fixture_admin',password:next}})).status,200);assert.deepEqual(await(await f.request('/api/admin/releases')).json(),before);await f.restart();assert.equal((await f.request('/api/admin/session')).status,200);assert.equal((await f.request('/api/admin/login',{auth:false,json:{username:'fixture_admin',password}})).status,401);assert.equal((await f.request('/api/admin/login',{auth:false,json:{username:'fixture_admin',password:next}})).status,200);const page=await(await f.request('/admin')).text();for(const s of ['id="password-form"','name="new_password"','name="confirm_password"','maxlength="128"'])assert.ok(page.includes(s));const log=await(await f.request('/api/admin/events')).text();assert.ok(!log.includes(next));}finally{await f.close()}});
