import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Sinty, initHome } from '../../../packages/core/.real-managed-checkpoint/sinty.js';
import { createApp } from '../../../packages/core/.real-managed-checkpoint/api/server.js';
test('existing single sidebar update control opens real owner review dialog; no placeholder or duplicate control', () => { const source = fs.readFileSync('apps/web/src/app.tsx', 'utf8'), dialog = fs.readFileSync('apps/web/src/harness-update-dialog.tsx', 'utf8'); assert.equal((source.match(/class="side-update"/g) ?? []).length, 1); assert.ok(source.slice(source.indexOf('class="side-update"'), source.indexOf('class="side-update"') + 800).includes("setUpdatesOpen(true)")); assert.match(source, /<HarnessUpdateDialog/); assert.doesNotMatch(source, /updateNote|side-update-note/); for (const route of ['managed', 'check', 'review', 'apply', 'recover'])
    assert.ok(dialog.includes('/v1/updates/' + route)); });
test('managed real API counts admitted asynchronous mutation until response; rejects new work during drain and refuses unsupported background lifecycle', async () => { const home = fs.mkdtempSync(join(tmpdir(), 'sinty-real-drain-')); initHome(home);fs.writeFileSync(join(home,"config.yaml"),JSON.stringify({supervisor:{enabled:false}})); const gate = { blocked: false }, s = new Sinty({ home, managed: { root: join(home, 'test-only-control'), version: '0.0.1001+managed.test', sha256: 'a'.repeat(64), instance: 'test-only', gate } }); try {
    const app = createApp(s);
    let stream;
    const body = new ReadableStream({ start(c) { stream = c; c.enqueue(new TextEncoder().encode('{"title":')); } }), request = new Request('http://localhost/v1/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + s.secrets.get('api.token'), 'Content-Type': 'application/json' }, body, duplex: 'half' }), pending = app.fetch(request);
    for (let i = 0; i < 100 && s.managedBusy === 0; i++)
        await delay(5);
    assert.equal(s.managedBusy, 1);
    gate.blocked = true;
    assert.equal((await app.request('/v1/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + s.secrets.get('api.token'), 'Content-Type': 'application/json' }, body: '{}' })).status, 503);
    assert.throws(() => s.beginManagedRequest(), /instance_draining/);
    stream.enqueue(new TextEncoder().encode('"admitted before drain"}'));
    stream.close();
    assert.equal((await pending).status, 201);
    assert.equal(s.managedBusy, 0);
    const fake = { loaded: { manifest: { entry: 'main.js', kinds: ['schedule'], updateMode: 'rpc-only' } }, inFlight: 0 };
    s.host.plugins.set('test-only', fake);
    assert.throws(() => s.assertManagedLifecycle(), /lifecycle_requires_review/);
    fake.loaded.manifest.kinds = ['tool'];
    s.assertManagedLifecycle();
    fake.loaded.manifest.updateMode = 'restart-required';
    assert.throws(() => s.assertManagedLifecycle(), /lifecycle_requires_review/);
    s.host.plugins.delete('test-only');
}
finally {
    s.host.plugins.delete('test-only');
    await s.stop();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
} });
