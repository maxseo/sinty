import http from 'node:http';import {processBirth} from './legacy-coordinator.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
let stop;
process.once('message', async ({ home, installRoot, nonce, expectedCoreHash,control }) => { try {
    const entry = path.join(installRoot, 'packages/core/dist/sinty.js');
    if (crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex') !== expectedCoreHash)
        throw Error('legacy_core_pin_mismatch');
    process.env.SINTY_INSTALL_ROOT = installRoot;
    process.env.SINTY_HOME = home;
    const { Sinty } = await import(pathToFileURL(entry).href), s = new Sinty({ home });
    // Cold read-only legacy adapter: construct the actual old core/API, but never start provider/plugins/supervisor/jobs from retained config.
    const { createApp } = await import(pathToFileURL(path.join(installRoot, 'packages/core/dist/api/server.js')).href), require = createRequire(entry), { serve } = await import(pathToFileURL(require.resolve('@hono/node-server')).href), app = createApp(s);
    let active = 0, blocked = false;
    const server = serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => { if (blocked || request.method !== 'GET' || !['/v1/sessions', '/v1/auth/me', '/v1/agent'].includes(new URL(request.url).pathname))
            return new Response('{}', { status: 503 }); active++; try {
            return await app.fetch(request);
        }
        finally {
            active--;
        } } }, info => {if(process.connected)process.send({ type: 'ready', url: 'http://127.0.0.1:' + info.port })});
    const identity=control?{session:control.session,home,coreHash:expectedCoreHash,pid:process.pid,birth:processBirth(process.pid)}:undefined;
    if(control){const controlServer=http.createServer(async(req,res)=>{if(req.headers.authorization!=="Bearer "+nonce){res.writeHead(401).end("{}");return}try{if(req.url==="/status")res.end(JSON.stringify(identity));else if(req.url==="/stop"&&req.method==="POST"){await stop();res.end(JSON.stringify(identity))}else res.writeHead(404).end("{}")}catch{res.writeHead(409).end("{}")}});await new Promise((r,reject)=>{controlServer.once("error",reject);controlServer.listen(control.pipe,r)})}
    stop = async () => { blocked = true; const until = Date.now() + 5000; while (active || s.agent.running.size) {
        if (Date.now() > until)
            throw Error('legacy_busy_no_kill');
        await delay(10);
    } await new Promise(r => server.close(r)); await s.stop();if(control){const record=identity,key=fs.readFileSync(path.join(control.root,"control/owner.token"),"utf8"),mac=crypto.createHmac("sha256",key).update(JSON.stringify(record)).digest("hex"),file=path.join(control.root,"control/exit-ack.json"),temp=file+".tmp";fs.writeFileSync(temp,JSON.stringify({record,mac}),{mode:0o600,flush:true});fs.renameSync(temp,file)}if(process.connected)process.disconnect();setTimeout(()=>process.exit(0),80); };
    if(control&&process.connected)process.send({type:'control-ready'});
    process.on('message', message => { if (message.action === 'stop' && message.nonce === nonce)
        void stop().catch(() => { process.send({ type: 'error', error: 'legacy_stop_failed_no_kill' }); }); });
}
catch(e) {
    if(process.connected)process.send({ type: 'error', error: 'legacy_profile_or_start_rejected' });
    process.exit(73);
} });

if(process.connected)process.send({type:"boot-ready"});
