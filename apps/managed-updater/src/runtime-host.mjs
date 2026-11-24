import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
process.once('message', async ({ root, home, descriptor: d }) => { let app, failed = false, ready = false, closed = false, busy = 0, blocked = false; const gate = { enter() { if (blocked)
        throw Error('instance_draining'); busy++; let done = false; return () => { if (!done) {
        done = true;
        busy--;
    } }; }, get blocked() { return blocked; } }; const server = http.createServer(async (req, res) => { try {
    if (req.headers.authorization !== 'Bearer ' + d.nonce) {
        res.statusCode = 401;
        res.end('{}');
        return;
    }
    let value = {};
    if (req.method === 'POST') {
        let s = '';
        for await (const b of req) {
            s += b;
            if (s.length > 4096)
                throw Error('control_limit');
        }
        value = JSON.parse(s || '{}');
    }
    if (req.url === '/status') {
        res.end(JSON.stringify({ instance: d.instance, pid: process.pid, version: d.version, sha256: d.sha256, ready: ready && await app.health(), failed, busy, blocked }));
        return;
    }
    if (req.method !== 'POST')
        throw Error('unsupported_control');
    if (req.url === '/drain') {
        blocked = true;
        const deadline = Date.now() + Math.min(Math.max(value.timeoutMs ?? 5000, 10), 60000);
        while (busy && Date.now() < deadline)
            await delay(20);
        if (busy) {
            blocked = false;
            throw Error('instance_busy');
        }
        try{if(app?.drain)await app.drain()}catch(e){await app?.resume?.();blocked=false;throw e}
        res.end('{}');
        return;
    }
    if (req.url === '/resume') {
        await app?.resume?.();blocked = false;
        res.end('{}');
        return;
    }
    if (req.url === '/stop') {
        if (!blocked || busy)
            throw Error('drain_required');
        await app?.stop();
        res.end('{}');
        if (!closed) {
            closed = true;
            server.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 1000).unref();
        }
        return;
    }
    throw Error('unsupported_control');
}
catch (e) {
    res.statusCode = 409;
    res.end(JSON.stringify({ error: e.message }));
} }); server.listen(d.pipe, async () => { try {
    const module = await import(pathToFileURL(path.join(root, 'versions', d.directory, 'app', 'managed-main.mjs')).href);
    app = await module.startManaged({ home, gate, runtime:{root,version:d.version,sha256:d.sha256,instance:d.instance} });
    if (!app || typeof app.health !== 'function' || typeof app.stop !== 'function')
        throw Error('managed_lifecycle_required');
    ready = true;
}
catch {
    failed = true;
} }); server.on('error', () => process.exit(72)); });
