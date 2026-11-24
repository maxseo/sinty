import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetadataPoller } from '../release-checks.js';
import { setTimeout as delay } from 'node:timers/promises';
test('periodic checks start nonblocking, singleflight, jittered six-hour schedule; never install', async () => { let count = 0; const p = new MetadataPoller(async () => { count++; await delay(10); return { configured: true, plugins: [{ version: '2.0.0' }], harness: [] }; }, { random: () => 0.5 }); p.start(); assert.equal(count, 0); const a = p.checkNow(), b = p.checkNow(); assert.equal(a, b); await a; assert.equal(count, 1); await delay(520); assert.equal(count, 2); const next = Date.parse(p.state.nextCheck!) - Date.now(); assert.ok(next > 5 * 3600000 && next < 7 * 3600000); p.stop(); assert.equal(p.state.nextCheck, null); });
test('offline errors retain last verified versions; unconfigured source does not invent availability', async () => { let fail = false; const p = new MetadataPoller(async () => { if (fail)
    throw Error('synthetic offline'); return { configured: true, plugins: [{ version: '1.0.0' }], harness: [] }; }); await p.checkNow(); const previous = p.state.lastSuccess; fail = true; await p.checkNow(); assert.equal(p.state.lastSuccess, previous); assert.equal(p.state.plugins.length, 1); assert.match(p.state.error!, /failed/); const unset = new MetadataPoller(async () => ({ configured: false, plugins: [], harness: [] })); await unset.checkNow(); assert.equal(unset.state.configured, false); assert.deepEqual(unset.state.harness, []); });
import { boot, tempHome } from './helpers.js';
import { createApp } from '../api/server.js';
test('core update status/check requires owner authentication and origin checks, independent from Marketplace runtime', async () => { const f = tempHome(), s = await boot(f.home, [], { plugins: ['fake-provider'], config: { updates: { enabled: false }, plugins: { disabled: ['tool-web', 'tool-browser', 'tool-vision', 'tool-stt', 'skills', 'mcp-catalog', 'responsive-turn'] } } as never }); try {
    const app = createApp(s), headers = { Authorization: 'Bearer ' + s.secrets.get('api.token')!, 'Content-Type': 'application/json' };
    assert.equal((await app.request('/v1/updates')).status, 401);
    assert.equal((await app.request('/v1/updates/check', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.invalid' }, body: '{}' })).status, 403);
    const r = await app.request('/v1/updates/check', { method: 'POST', headers, body: '{}' });
    assert.equal(r.status, 200);
    assert.equal((await r.json() as {
        configured: boolean;
    }).configured, false);
    assert.equal(s.host.plugins.has('plugin-catalog'), false);
}
finally {
    const ps = [...s.host.plugins.values()];
    await s.stop();
    await Promise.all(ps.map(p => p.stopAndWait()));
    f.cleanup();
} });
