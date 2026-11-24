import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z, type ToolDefinition, type ToolRunContext } from "@sinty/sdk";
import { connectMcp } from "../host/mcp-stdio.js";
import type { InitMessage } from "../host/protocol.js";

// Synthetic server only. Never opens a browser, network connection or user profile.
const SERVER = String.raw`
const fs=require('node:fs');const [mode,log,variant]=process.argv.slice(2);let buf=Buffer.alloc(0),cancelled=[],calls=0;
function note(){fs.writeFileSync(log+'.tmp',JSON.stringify({pid:process.pid,cancelled,calls}));fs.renameSync(log+'.tmp',log);}note();
function send(msg){const body=Buffer.from(JSON.stringify(msg));const frame=mode==='ndjson'?Buffer.concat([body,Buffer.from('\n')]):Buffer.concat([Buffer.from('Content-Length: '+body.length+'\r\n\r\n'),body]);process.stdout.write(frame.subarray(0,7));process.stdout.write(frame.subarray(7));}
function reply(m,result){send({jsonrpc:'2.0',id:m.id,result});}
function receive(m){
 if(m.method==='initialize'){
  if(variant==='hang-init')return;
  if(variant==='malformed'){process.stdout.write(mode==='ndjson'?'not-json\n':'Content-Length: no\r\n\r\n');return;}
  if(variant==='oversize'){process.stdout.write('Content-Length: 999999999\r\n\r\n');return;}
  if(variant==='huge-ndjson'){process.stdout.write(Buffer.alloc(16*1024*1024+8193,120));return;}
  if(variant==='exit'){process.exit(7);return;}
  process.stderr.write('synthetic diagnostic drained\n');reply(m,{protocolVersion:'2024-11-05',capabilities:{tools:{}}});return;
 }
 if(m.method==='tools/list'){
  const schema=variant==='bad-schema'?{type:'object',$ref:'https://invalid.example/schema'}:{type:'object',properties:{value:{type:'string',minLength:1,description:'real value'}},required:['value'],additionalProperties:false};
  const tools=['echo','mixed','hold','error','ping-server'].map(name=>({name,description:'Synthetic '+name,inputSchema:schema}));
  if(variant==='pagination'&&!m.params.cursor){reply(m,{tools:tools.slice(0,2),nextCursor:'page-2'});return;}
  if(variant==='loop'){reply(m,{tools:[],nextCursor:'same'});return;}
  reply(m,{tools:variant==='pagination'?tools.slice(2):tools});return;
 }
 if(m.method==='notifications/cancelled'){cancelled.push(m.params.requestId);note();return;}
 if(m.method==='tools/call'){
  calls++;note();const name=m.params.name;
  if(name==='hold'){if(variant==='late-reply')setTimeout(()=>reply(m,{content:[{type:'text',text:'late'}]}),400);return;}
  if(name==='error'){send({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'synthetic failure'}});return;}
  if(name==='ping-server'){send({jsonrpc:'2.0',id:m.id,method:'ping'});setTimeout(()=>reply(m,{content:[{type:'text',text:'after server ping'}]}),5);return;}
  if(name==='mixed'){reply(m,{content:[{type:'text',text:'synthetic image'},{type:'image',mimeType:'image/png',data:'aGVsbG8='}],structuredContent:{synthetic:true}});return;}
  reply(m,{content:[{type:'text',text:m.params.arguments.value}]});
 }
}
process.stdin.on('data',chunk=>{buf=Buffer.concat([buf,chunk]);for(;;){let body;if(mode==='ndjson'){const n=buf.indexOf(10);if(n<0)return;body=buf.subarray(0,n);buf=buf.subarray(n+1);}else{const n=buf.indexOf('\r\n\r\n');if(n<0)return;const len=Number(/Content-Length:\s*(\d+)/i.exec(buf.subarray(0,n).toString())[1]);if(buf.length<n+4+len)return;body=buf.subarray(n+4,n+4+len);buf=buf.subarray(n+4+len);}receive(JSON.parse(body.toString()));}});
`;

function fixture(t: TestContext, transport: "ndjson" | "content-length", variant = "ok", timeout = 1000) {
  const dir = mkdtempSync(join(tmpdir(), "sinty-mcp-adapter-"));
  const file = join(dir, "server.cjs"), log = join(dir, "state.json");
  writeFileSync(file, SERVER);
  let stop: (() => void) | undefined;
  t.after(async () => {
    stop?.();
    // Windows can release the child cwd handle shortly after the process exits.
    await delay(80);
    await rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 30 });
  });
  const init = {
    t: "init", manifest: { name: "fixture", version: "0.1.0", description: "test", kinds: ["tool"], runtime: "mcp-stdio", command: [process.execPath, file, transport, log, variant], permissions: {} },
    entry: "", config: { ...(transport === "ndjson" ? { stdioTransport: "ndjson" } : {}), stdioRequestTimeoutMs: timeout },
    secrets: {}, net: { manifest: [], policy: [] }, paths: { plugin: dir, data: dir, workspace: dir, skills: dir },
  } as InitMessage;
  const tools: ToolDefinition[] = [];
  return { init, tools, log, start: () => connectMcp(init, (tool) => tools.push(tool), (close) => { stop = close; }), close: () => stop?.() };
}
function ctx(signal = new AbortController().signal): ToolRunContext {
  return { sessionId: "test", turnId: "test", callId: "test", idempotencyKey: "test", signal, progress() {} };
}
function tool(f: { tools: ToolDefinition[] }, name: string) { return f.tools.find((t) => t.name === `fixture.${name}`)!; }
async function cancelled(log: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(log) && JSON.parse(readFileSync(log, "utf8")).cancelled.length) return;
    await delay(10);
  }
  assert.fail("server did not receive notifications/cancelled");
}

for (const mode of ["content-length", "ndjson"] as const) {
  test(`MCP adapter: ${mode}, real schema and unicode text survive`, async (t) => {
    const f = fixture(t, mode); await f.start();
    assert.equal(f.tools.length, 5);
    const def = tool(f, "echo"), schema = z.toJSONSchema(def.input, { io: "input", unrepresentable: "any" });
    assert.deepEqual(schema.required, ["value"]);
    const valueSchema = schema.properties?.value;
    assert.ok(valueSchema && typeof valueSchema === "object");
    assert.equal(valueSchema.type, "string");
    assert.equal(def.input.safeParse({}).success, false);
    assert.equal(def.input.safeParse({ value: 12 }).success, false);
    assert.equal(def.input.safeParse({ value: "x", unexpected: true }).success, false);
    const result = await def.run(def.input.parse({ value: "Привет 🌍" }), ctx());
    assert.equal(result.content, "Привет 🌍");
  });
}
test("MCP adapter: image and structured result remain alongside text", async (t) => {
  const f = fixture(t, "ndjson"); await f.start();
  const out = await tool(f, "mixed").run({ value: "x" }, ctx());
  assert.deepEqual(out.content, { content: [{ type: "text", text: "synthetic image" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }], structuredContent: { synthetic: true } });
});
test("MCP adapter: abort notifies server and bounds caller wait", async (t) => {
  const f = fixture(t, "ndjson"); await f.start(); const ac = new AbortController();
  const p = tool(f, "hold").run({ value: "x" }, ctx(ac.signal));
  const rejected = assert.rejects(p, (e: { code?: string }) => e.code === "aborted");
  ac.abort(); await rejected; await cancelled(f.log);
  assert.equal((await tool(f, "echo").run({ value: "still works" }, ctx())).content, "still works");
});
test("MCP adapter: timeout notifies server without orphaned pending caller", async (t) => {
  const f = fixture(t, "ndjson", "ok", 500); await f.start();
  await assert.rejects(tool(f, "hold").run({ value: "x" }, ctx()), (e: { code?: string }) => e.code === "timeout");
  await cancelled(f.log);
});
test("MCP adapter: pre-aborted call is never sent", async (t) => {
  const f = fixture(t, "ndjson"); await f.start(); const ac = new AbortController(); ac.abort();
  await assert.rejects(tool(f, "echo").run({ value: "not sent" }, ctx(ac.signal)), /cancelled/);
  assert.equal(JSON.parse(readFileSync(f.log, "utf8")).calls, 0);
});
test("MCP adapter: RPC errors and server requests are not confused", async (t) => {
  const f = fixture(t, "ndjson"); await f.start();
  await assert.rejects(tool(f, "error").run({ value: "x" }, ctx()), /synthetic failure/);
  assert.equal((await tool(f, "ping-server").run({ value: "x" }, ctx())).content, "after server ping");
});
for (const [mode, variant, error] of [
  ["ndjson", "malformed", /invalid JSON-RPC/],
  ["content-length", "malformed", /invalid Content-Length/],
  ["content-length", "oversize", /exceeds 16 MiB/],
  ["ndjson", "huge-ndjson", /exceeds 16 MiB/],
  ["ndjson", "exit", /server exited/],
  ["ndjson", "hang-init", /timed out/],
  ["ndjson", "bad-schema", /External \$ref/],
  ["ndjson", "loop", /pagination exceeds/],
] as const) {
  test(`MCP adapter: ${mode} ${variant} fails bounded and registers nothing`, async (t) => {
    const f = fixture(t, mode, variant, variant === "hang-init" ? 500 : 2000);
    await assert.rejects(f.start(), error); assert.equal(f.tools.length, 0);
  });
}
test("MCP adapter: bounded paginated catalog", async (t) => {
  const f = fixture(t, "ndjson", "pagination"); await f.start(); assert.equal(f.tools.length, 5);
});
test("MCP adapter: close rejects an outstanding call and is idempotent", async (t) => {
  const f = fixture(t, "content-length"); await f.start();
  const pending = tool(f, "hold").run({ value: "x" }, ctx());
  const rejected = assert.rejects(pending, /connection closed/); f.close(); f.close(); await rejected;
});

test("MCP adapter: a late timed-out reply cannot satisfy another request", async (t) => {
  const f = fixture(t, "ndjson", "late-reply", 200); await f.start();
  await assert.rejects(tool(f, "hold").run({ value: "x" }, ctx()), (e: { code?: string }) => e.code === "timeout");
  await delay(250);
  assert.equal((await tool(f, "echo").run({ value: "current" }, ctx())).content, "current");
});
