import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import plugin from './index.js';
import type { PluginContext, ProviderDefinition, ProviderRequest, ProviderChunk } from '@sinty/sdk';
const root = fileURLToPath(new URL('..', import.meta.url));
const collect = async (it: AsyncIterable<ProviderChunk>) => { const out: ProviderChunk[] = []; for await (const x of it)
    out.push(x); return out; };
const sse = (rows: unknown[]) => rows.map(x => 'data: ' + (typeof x === 'string' ? x : JSON.stringify(x)) + '\n\n').join('');
const textEvents = (p: string) => p === 'anthropic' ? sse([{ type: 'message_start', message: { usage: { input_tokens: 11 } } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }]) : p === 'openai-responses' ? sse([{ type: 'response.output_text.delta', delta: 'fixture' }, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 11, output_tokens: 3 } } }]) : sse([{ choices: [{ index: 0, delta: { content: 'fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 3 } }, '[DONE]']);
const request = (): ProviderRequest => ({ endpoint: { baseUrl: 'https://mock.invalid/v1', apiKey: 'synthetic-fixture-only', options: { temperature: 0.1, toolCallNameMode: 'catalog-compatible', promptCacheKey: true } }, model: 'arbitrary-model', messages: [{ role: 'system', content: 'Synthetic only', cacheHint: 'static' }, { role: 'user', content: 'hello', cacheHint: 'turn' }], tools: [{ name: 'fs__read', description: 'Read fixture', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }, { name: 'dynamic-tools__search', description: 'Discover tools', inputSchema: { type: 'object' } }, { name: 'runninghub__generate', description: 'Generate image', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } }], signal: new AbortController().signal, cacheKey: 'synthetic-cache-key', reasoning: 'off' });
for (const protocol of ['openai-compat', 'anthropic', 'openai-responses'])
    test('real ' + protocol + ' adapter OFF payload, stream, signal and options equal direct adapter', async () => { const data = mkdtempSync(join(tmpdir(), 'sinty-dynamic-adapter-')), wrapped = new Map<string, ProviderDefinition>(), direct = new Map<string, ProviderDefinition>(), sent: {
        url: string;
        init: RequestInit;
    }[] = []; const ctx = { paths: { plugin: root, data }, provider: (d: ProviderDefinition) => wrapped.set(d.protocol, d), tool: () => { }, context: () => { }, http: () => { }, net: { fetch: async (url: string, init: RequestInit) => { sent.push({ url, init }); return new Response(textEvents(protocol), { headers: { 'content-type': 'text/event-stream' } }); } } } as unknown as PluginContext; try {
        await plugin.setup(ctx);
        const folder = protocol === 'anthropic' ? 'provider-anthropic' : protocol === 'openai-responses' ? 'provider-openai-responses' : 'provider-openai-compat', m = await import(pathToFileURL(resolve(root, '..', folder, 'dist/index.js')).href);
        await m.default.setup({ ...ctx, provider: (d: ProviderDefinition) => direct.set(d.protocol, d) });
        const req = request(), a = await collect(wrapped.get(protocol)!.stream(req)), b = await collect(direct.get(protocol)!.stream(req));
        assert.deepEqual(a, b);
        assert.equal(sent.length, 2);
        assert.equal(sent[0]!.url, sent[1]!.url);
        assert.equal(sent[0]!.init.body, sent[1]!.init.body);
        assert.deepEqual(sent[0]!.init.headers, sent[1]!.init.headers);
        assert.equal(sent[0]!.init.signal, req.signal);
        assert(!String(sent[0]!.init.body).includes('__SINTY_DYNAMIC'));
    }
    finally {
        rmSync(data, { recursive: true });
    } });
for (const model of ['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-fixture', 'deepseek/fixture'])
    test('actual RH catalog-compatible adapter retained through wrapper: ' + model, async () => { const data = mkdtempSync(join(tmpdir(), 'sinty-dynamic-rh-')), providers = new Map<string, ProviderDefinition>(), routes = new Map<string, any>(); let context: any, search: any, requests = 0; const parts = ['{"path":', '"diagnostic-', 'fixture', '.txt"', '}', '']; const response = sse([...parts.map((args, i) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'captured-shape-fixture', type: 'function', function: { name: 'fs__read', arguments: args } }] }, finish_reason: i === 5 ? 'tool_calls' : null }] })), { choices: [], usage: { prompt_tokens: 12, completion_tokens: 8 } }, '[DONE]']); const ctx = { paths: { plugin: root, data }, provider: (d: ProviderDefinition) => providers.set(d.protocol, d), context: (_n: string, fn: any) => { context = fn; }, tool: (t: any) => { search = t; }, http: (r: any) => routes.set(r.path, r), net: { fetch: async () => { requests++; return new Response(response, { headers: { 'content-type': 'text/event-stream' } }); } } } as unknown as PluginContext; try {
        await plugin.setup(ctx);
        const settingsRoute = routes.get('/settings');
        await settingsRoute.handler(new Request('http://fixture/settings', { method: 'POST', body: JSON.stringify({ enabled: true, retention: 'chat', pinned: ['fs.read'] }) }));
        const req = request();
        req.model = model;
        req.messages = await context({ sessionId: 'A', messages: req.messages });
        const output = await collect(providers.get('openai-compat')!.stream(req)), calls = output.filter(c => c.type === 'tool_call');
        assert.equal(requests, 1);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], { type: 'tool_call', id: 'captured-shape-fixture', name: 'fs__read', args: { path: 'diagnostic-fixture.txt' } });
        assert.equal(search.name, 'dynamic-tools.search');
        assert.equal(output.at(-1)?.type, 'done');
    }
    finally {
        rmSync(data, { recursive: true });
    } });
for(const protocol of ['openai-compat','anthropic','openai-responses'])test('real '+protocol+' dynamic discovery forwards the true selected schema on the next request',async()=>{
 const data=mkdtempSync(join(tmpdir(),'sinty-dynamic-schema-')),providers=new Map<string,ProviderDefinition>(),routes=new Map<string,any>(),bodies:any[]=[];let context:any,search:any;
 const events=protocol==='anthropic'?sse([{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'discover',name:'dynamic-tools__search'}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"query":"runninghub"}'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:2}},{type:'message_stop'}]):protocol==='openai-responses'?sse([{type:'response.output_item.done',item:{type:'function_call',call_id:'discover',name:'dynamic-tools__search',arguments:'{"query":"runninghub"}'}},{type:'response.completed',response:{usage:{input_tokens:5,output_tokens:2}}}]):sse([{choices:[{index:0,delta:{tool_calls:[{index:0,id:'discover',type:'function',function:{name:'dynamic-tools__search',arguments:'{"query":"runninghub"}'}}]},finish_reason:'tool_calls'}]},'[DONE]']);
 const ctx={paths:{plugin:root,data},provider:(d:ProviderDefinition)=>providers.set(d.protocol,d),context:(_n:string,fn:any)=>{context=fn;},tool:(t:any)=>{search=t;},http:(r:any)=>routes.set(r.path,r),net:{fetch:async(_url:string,init:RequestInit)=>{bodies.push(JSON.parse(String(init.body)));return new Response(bodies.length===1?events:textEvents(protocol),{headers:{'content-type':'text/event-stream'}});}}}as unknown as PluginContext;
 try{await plugin.setup(ctx);await routes.get('/settings').handler(new Request('http://fixture/settings',{method:'POST',body:JSON.stringify({enabled:true,retention:'chat',pinned:['fs.read']})}));const req=request();req.messages=await context({sessionId:'A',messages:req.messages});const first=await collect(providers.get(protocol)!.stream(req));assert(first.some(c=>c.type==='tool_call'&&c.name==='dynamic-tools__search'));const result=await search.run({query:'runninghub',limit:1},{sessionId:'A',callId:'discover',idempotencyKey:'A:discover'});assert.equal(result.content.matches[0].name,'runninghub.generate');const next=request();next.messages.push({role:'tool',content:JSON.stringify(result.content),toolCallId:'discover'});next.messages=await context({sessionId:'A',messages:next.messages});await collect(providers.get(protocol)!.stream(next));const toolName=(t:any)=>t.function?.name??t.name;assert.deepEqual(bodies[0].tools.map(toolName),['fs__read','dynamic-tools__search']);assert.deepEqual(bodies[1].tools.map(toolName),['fs__read','dynamic-tools__search','runninghub__generate']);const t=bodies[1].tools.find((t:any)=>toolName(t)==='runninghub__generate');assert.deepEqual(t.function?.parameters??t.input_schema??t.parameters,request().tools[2]!.inputSchema);assert(bodies.every(b=>!JSON.stringify(b).includes('__SINTY_DYNAMIC_TOOLS_V1')));assert.equal(bodies.length,2);}finally{rmSync(data,{recursive:true});}
});
