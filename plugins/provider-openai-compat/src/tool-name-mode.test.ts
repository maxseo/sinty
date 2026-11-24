import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginContext, ProviderChunk, ProviderDefinition, ProviderRequest } from "@sinty/sdk";
import plugin, { buildBody } from "./index.js";
const options = { toolCallNameMode: "catalog-compatible" };
const request = (names = ["fs__read", "fs__list"], configured = true, model = "arbitrary/future-model"): ProviderRequest => ({
  endpoint: { baseUrl: "https://fixture.invalid", ...(configured ? { options } : {}) }, model,
  messages: [{ role: "user", content: "Synthetic fixture only" }],
  tools: names.map(name => ({ name, description: "fake, never executed", inputSchema: { type: "object" } })), signal: new AbortController().signal,
});
const tool = (name: string | undefined, args = "", index = 1, id: string | undefined = "fixture-call") => ({
  index, ...(id !== undefined ? { id } : {}), function: { ...(name !== undefined ? { name } : {}), arguments: args },
});
const frame = (calls: unknown[], index = 0) => ({ choices: [{ index, delta: { tool_calls: calls } }] });
const terminal = { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
async function collect(frames: unknown[], req = request()) {
  let provider!: ProviderDefinition, fetches = 0;
  const chunks: ProviderChunk[] = []; let error: unknown;
  const wire = [...frames, terminal, { choices: [], usage: { prompt_tokens: 459, completion_tokens: 78 } }]
    .map(f => "data: " + JSON.stringify(f) + "\n\n").join("") + "data: [DONE]\n\n";
  await plugin.setup({ provider(p: ProviderDefinition) { provider = p; }, net: { async fetch(url: string, init: RequestInit) {
    assert.equal(url, "https://fixture.invalid/chat/completions"); fetches++;
    assert.ok(!("toolCallNameMode" in JSON.parse(String(init.body))));
    return new Response(wire, { headers: { "content-type": "text/event-stream" } });
  } } } as unknown as PluginContext);
  try { for await (const chunk of provider.stream(req)) chunks.push(chunk); } catch(e) { error=e; }
  return {chunks,error,fetches};
}
const calls = (chunks: ProviderChunk[]) => chunks.filter(c => c.type === "tool_call");
async function refused(frames: unknown[], req = request(), code?: string) {
  const out = await collect(frames,req); assert.equal(out.error,undefined); assert.deepEqual(calls(out.chunks),[]);
  const text=out.chunks.filter(c=>c.type==='text').map(c=>c.text).join(''); assert.match(text,/Sinty adapter error:/);
  if(code) assert.ok(text.includes(code)); assert.ok(!text.includes('PRIVATE_SENTINEL'));
  assert.deepEqual(out.chunks.at(-1),{type:'done',stopReason:'stop',usage:{inputTokens:459,outputTokens:78}});
  assert.equal(out.fetches,1); // Usage accepted, local refusal visible; no transport exception/fallback request.
}
test("provider-wide: captured RH six-name stream works identically for Opus, Sonnet, DeepSeek and arbitrary future IDs", async()=>{
  const args=JSON.stringify({path:'diagnostic-fixture.txt'});let offset=0;
  // Sanitized real capture 2026-11-10 17:09 MSK: choice0/index1/same ID, six complete names.
  const frames=[0,0,12,8,10,3].map(length=>{const part=args.slice(offset,offset+length);offset+=length;return frame([tool('fs__read',part)]);});
  assert.equal(offset,args.length);
  for(const model of ['anthropic/claude-opus-5.5','anthropic/claude-sonnet-5.5','deepseek/deepseek-flash','vendor/new-model']){
    const out=await collect(frames,request(undefined,true,model)); assert.equal(out.error,undefined);
    assert.deepEqual(calls(out.chunks),[{type:'tool_call',id:'fixture-call',name:'fs__read',args:{path:'diagnostic-fixture.txt'}}]);
    assert.equal(out.chunks.at(-1)?.type,'done');
  }
});
test("compatible: single complete name once with argument-only later fields",async()=>{
  const out=await collect([frame([tool('fs__read','{"path":')]),frame([{index:1,function:{arguments:'"x"}'}}])]);
  assert.equal(out.error,undefined);assert.deepEqual(calls(out.chunks)[0]?.args,{path:'x'});
});
test("compatible: genuine fragmented names and repeated complete metadata after full assembly",async()=>{
  for(const names of [['fs__','read'],['fs__','read','fs__read','fs__read']]){
    const out=await collect(names.map((name,i)=>frame([tool(name,i===0?'{}':'')])));
    assert.equal(out.error,undefined);assert.equal(calls(out.chunks)[0]?.name,'fs__read');
  }
});
test("compatible: identical partial fragments are concatenated, not deduplicated",async()=>{
  const out=await collect([frame([tool('foo','{')]),frame([tool('foo','}')])],request(['foofoo']));
  assert.equal(calls(out.chunks)[0]?.name,'foofoo');
});
test("compatible: argument fragments are never deduplicated",async()=>{
  const out=await collect(['{"text":"','ab','ab','"}'].map(args=>frame([tool('fs__read',args)])));
  assert.deepEqual(calls(out.chunks)[0]?.args,{text:'abab'});
});
test("compatible: interleaved indices and IDs remain isolated and sorted",async()=>{
  const out=await collect([frame([tool('fs__','{"path":',1,'one'),tool('fs__list','{"path":',3,'two')]),frame([tool('fs__list','"b"}',3,'two'),tool('read','"a"}',1,'one')])]);
  assert.equal(out.error,undefined);assert.deepEqual(calls(out.chunks).map(c=>[c.id,c.name,c.args]),[['one','fs__read',{path:'a'}],['two','fs__list',{path:'b'}]]);
});
test("compatible: catalog prefix collision remains ambiguous, never silently chooses short tool",async()=>{
  for(const names of [['foo','foofoo'],['foo','foofoobar']])await refused([frame([tool('foo','{')]),frame([tool('foo','}')])],request(names),'ambiguous_tool_name');
});
test("compatible: later fragments can disambiguate a longer catalog name",async()=>{
  const out=await collect([frame([tool('foo','{')]),frame([tool('foo','')]),frame([tool('bar','}')])],request(['foo','foofoobar']));
  assert.equal(calls(out.chunks)[0]?.name,'foofoobar');
});
test("compatible: explicit completion of short versus longer name without ambiguity",async()=>{
  const a=await collect([frame([tool('foo','{}')])],request(['foo','foobar']));assert.equal(calls(a.chunks)[0]?.name,'foo');
  const b=await collect([frame([tool('foo','{')]),frame([tool('bar','}')])],request(['foo','foobar']));assert.equal(calls(b.chunks)[0]?.name,'foobar');
});
test("compatible: changing or concatenated unknown name is not repaired into advertised tool",async()=>{
  await refused([frame([tool('fs__read','{}')]),frame([tool('fs__list')])]);
  await refused([frame([tool('fs__readfs__read','{}')])]);
  await refused([frame([tool('PRIVATE_SENTINEL','{}')])]);
});
test("compatible: conflicting call ID at same index or reuse across indices emits no calls",async()=>{
  await refused([frame([tool('fs__read','{}',1,'one')]),frame([tool('fs__read','',1,'two')])],request(),'tool_identity_conflict');
  await refused([frame([tool('fs__read','{}',1),tool('fs__list','{}',2)])],request(),'tool_identity_conflict');
});
test("compatible: all calls resolved before any dispatch if a later call is bad",async()=>{
  await refused([frame([tool('fs__read','{}',1,'one'),tool('PRIVATE_SENTINEL','{}',2,'two')])]);
});
test("compatible: missing/negative index, missing ID/name, malformed call fields safely retain usage",async()=>{
  for(const t of [{id:'one',function:{name:'fs__read',arguments:'{}'}},tool('fs__read','{}',-1),{index:1,function:{name:'fs__read',arguments:'{}'}},tool(undefined,'{}'),null,{index:1,id:'one',function:{name:'fs__read',arguments:3}}])await refused([frame([t])]);
});
test("compatible: choices are not mixed; unsupported multiple/nonzero choice refuses without losing usage",async()=>{
  await refused([frame([tool('fs__read','{}')],1)]);
  await refused([{choices:[{index:0,delta:{tool_calls:[tool('fs__read','{}')]}},{index:1,delta:{tool_calls:[tool('fs__list','{}')]}}]}]);
});
test("compatible: separate requests with same IDs have isolated name state",async()=>{
  for(const name of ['fs__read','fs__list']){const out=await collect([frame([tool(name,'{}')])]);assert.equal(calls(out.chunks)[0]?.name,name);}
});
test("duplicate advertised wire names fail before fetch, rather than choosing a schema",async()=>{
  const out=await collect([],request(['foo','foo']));assert.equal(out.fetches,0);assert.match(String(out.error),/Duplicate or invalid advertised tool names/);
});
test("default delta on other providers preserves normal, fragmented and equal name fragments",async()=>{
  for(const names of [['fs__read'],['fs__','read'],['foo','foo']]){const out=await collect(names.map((n,i)=>frame([tool(n,i===0?'{}':'')])),request(['foo','foofoo'],false));assert.equal(out.error,undefined);assert.equal(calls(out.chunks)[0]?.name,names.join(''));}
});
test("provider option and removed model map are local; other request options unchanged",()=>{
  const r=request();r.endpoint.options={...options,toolCallNameModes:{obsolete:'repeated-full'},temperature:0};const body=buildBody(r);
  assert.ok(!('toolCallNameMode' in body));assert.ok(!('toolCallNameModes' in body));assert.equal(body.temperature,0);
});
test("invalid local mode fails before fetch and does not expose config value",async()=>{
  const r=request();r.endpoint.options={toolCallNameMode:'PRIVATE_SENTINEL'};const out=await collect([],r);assert.equal(out.fetches,0);assert.match(String(out.error),/Invalid local toolCallNameMode/);assert.ok(!String(out.error).includes('PRIVATE_SENTINEL'));
});
