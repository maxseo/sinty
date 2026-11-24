import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SintyEvent } from "@sinty/sdk";
import { persistMcpImages, renderMcpImage, MCP_IMAGE_MAX } from "../mcp-images.js";
import { eventsToMessages } from "../agent.js";
import { policySchema } from "../config.js";
import { boot, tempHome } from "./helpers.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwN8AAAAASUVORK5CYII=";
const block = (data = PNG) => ({ type: "image", mimeType: "image/png", data });
const result = () => ({ content: [{ type: "text", text: "Synthetic screenshot" }, block()] });
function event(seq: number, type: string, data: unknown): SintyEvent { return { seq, type, data, sessionId: "s", turnId: "t", ts: "2026-11-18T17:00:00Z", actor: { kind: "plugin", id: "fixture" } } as SintyEvent; }

test("MCP images: inline bytes become hash artifacts, replay sees real image bytes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sinty-mcp-images-")); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }));
  const out = persistMcpImages(dir, result());
  assert.equal(out.blobs?.length, 1); assert.ok(!JSON.stringify(out.content).includes(PNG));
  const ref = out.blobs![0]!; assert.ok(existsSync(join(dir, "blobs", ref.blob.slice(7))));
  assert.deepEqual(renderMcpImage(dir, ref), { mime: "image/png", data: PNG });
  const evs = [event(1, "model.response", { text: "", toolCalls: [{ callId: "c", tool: "fixture.capture", args: {} }] }), event(2, "tool.call.completed", { callId: "c", result: out.content, blobs: out.blobs, durationMs: 1 })];
  const before = JSON.stringify(evs); assert.ok(!before.includes(PNG));
  const messages = eventsToMessages(evs, dir);
  assert.equal(messages.at(-1)?.role, "user"); assert.equal(messages.at(-1)?.untrusted, true);
  assert.equal(messages.at(-1)?.images?.[0]?.data, PNG);
  assert.ok(messages.at(-1)?.content.includes('"callId":"c"'));
  assert.deepEqual(eventsToMessages(JSON.parse(before), dir), messages, "transcript replay reconstructs artifact pixels");
  assert.equal(eventsToMessages(evs).some((m) => m.images?.length), false);
});
test("MCP images: duplicate inline payloads in structured metadata and rawJson use the same artifact", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sinty-mcp-images-")); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }));
  const out = persistMcpImages(dir, { ...result(), structuredContent: { title: "fixture", image: PNG, rawJson: JSON.stringify({ image: PNG }), dataUri: "data:image/png;base64," + PNG } });
  const normalized = JSON.stringify(out.content);
  assert.ok(!normalized.includes(PNG)); assert.ok(normalized.includes(out.blobs![0]!.blob));
  assert.equal((out.content as { structuredContent: { title: string } }).structuredContent.title, "fixture");
  assert.equal(out.blobs?.length, 1);
});
test("MCP images: parallel tool results precede image observations", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sinty-mcp-images-")); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }));
  const out = persistMcpImages(dir, result());
  const events = [event(1, "model.response", { toolCalls: [{ callId: "a", tool: "x", args: {} }, { callId: "b", tool: "y", args: {} }] }), event(2, "tool.call.completed", { callId: "a", result: out.content, blobs: out.blobs }), event(3, "tool.call.completed", { callId: "b", result: "text only" })];
  assert.deepEqual(eventsToMessages(events, dir).map((m) => m.role), ["assistant", "tool", "tool", "user"]);
});
test("MCP images: image count and context replay budget stay bounded", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sinty-mcp-images-")); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }));
  assert.throws(() => persistMcpImages(dir, { content: Array.from({ length: 5 }, () => block()) }), /invalid or unsupported/);
  const out = persistMcpImages(dir, result()); const events: SintyEvent[] = [];
  for (let i = 0; i < 8; i++) { events.push(event(i * 2, "model.response", { toolCalls: [{ callId: `c${i}`, tool: "x", args: {} }] }), event(i * 2 + 1, "tool.call.completed", { callId: `c${i}`, result: out.content, blobs: out.blobs })); }
  assert.equal(eventsToMessages(events, dir).reduce((n, m) => n + (m.images?.length ?? 0), 0), 4);
});
test("MCP images: reject malformed base64, mismatched MIME, dimensions and oversized data", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sinty-mcp-images-")); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }));
  for (const b of [block("%%%="), { ...block(), mimeType: "image/svg+xml" }, { ...block(), mimeType: "image/jpeg" }, block("YQ=="), block("A".repeat(Math.ceil(MCP_IMAGE_MAX / 3) * 4 + 4))]) assert.throws(() => persistMcpImages(dir, { content: [b] }));
  const tooWide = Buffer.from(PNG, "base64"); tooWide.writeUInt32BE(9000, 16);
  assert.throws(() => persistMcpImages(dir, { content: [block(tooWide.toString("base64"))] }), /dimensions/);
  assert.equal(existsSync(join(dir, "blobs")), false, "invalid batches create no artifacts");
});
test("MCP images: text and URI resources unchanged; no URL or local file is loaded", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sinty-mcp-images-")); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }));
  assert.deepEqual(persistMcpImages(dir, "plain text"), { content: "plain text" });
  const data = { content: [{ type: "resource_link", uri: "file:///not-allowed/secret.png" }, { type: "resource", resource: { uri: "https://invalid.example/picture" } }] };
  assert.equal(persistMcpImages(dir, data).content, data); assert.equal(existsSync(join(dir, "blobs")), false);
});
test("MCP images: replay refuses modified, forged, missing and path-like refs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sinty-mcp-images-")); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }));
  const ref = persistMcpImages(dir, result()).blobs![0]!;
  assert.equal(renderMcpImage(dir, { ...ref, bytes: 1 }), undefined);
  assert.equal(renderMcpImage(dir, { ...ref, blob: "sha256:../../secret" }), undefined);
  assert.equal(renderMcpImage(dir, { ...ref, blob: `sha256:${"f".repeat(64)}` }), undefined);
  const file = join(dir, "blobs", ref.blob.slice(7)); const bytes = readFileSync(file); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; writeFileSync(file, bytes);
  assert.equal(renderMcpImage(dir, ref), undefined);
});
test("MCP images: real host journals refs, not base64, and transcript replay restores image bytes", async (t) => {
  const { home } = tempHome(); t.after(() => rm(home, { recursive: true, force: true, maxRetries: 15, retryDelay: 30 }));
  const plugin = join(home, "plugins", "image-fixture"); mkdirSync(plugin, { recursive: true });
  const server = join(plugin, "server.cjs");
  writeFileSync(server, `let b=Buffer.alloc(0);function send(m){const x=Buffer.from(JSON.stringify(m));process.stdout.write('Content-Length: '+x.length+'\\r\\n\\r\\n');process.stdout.write(x)};process.stdin.on('data',c=>{b=Buffer.concat([b,c]);for(;;){let n=b.indexOf('\\r\\n\\r\\n');if(n<0)return;let len=Number(/Content-Length:\\s*(\\d+)/i.exec(b.subarray(0,n).toString())[1]);if(b.length<n+4+len)return;let m=JSON.parse(b.subarray(n+4,n+4+len));b=b.subarray(n+4+len);if(m.id===undefined)continue;send({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{capabilities:{}}:m.method==='tools/list'?{tools:[{name:'capture',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}:${JSON.stringify(result())}})}});`);
  writeFileSync(join(plugin, "sinty.plugin.json"), JSON.stringify({ name: "image-fixture", version: "0.1.0", description: "synthetic only", kinds: ["tool"], runtime: "mcp-stdio", command: [process.execPath, server], permissions: {} }));
  const provider = join(home, "plugins", "image-provider-fixture"); mkdirSync(provider, { recursive: true });
  writeFileSync(join(provider, "sinty.plugin.json"), JSON.stringify({ name: "image-provider-fixture", version: "0.1.0", description: "synthetic observer; no network", kinds: ["provider"], runtime: "node", entry: "index.mjs", permissions: {} }));
  writeFileSync(join(provider, "index.mjs"), `export default { setup(ctx) { ctx.provider({protocol:"synthetic-image-reader", async *stream(req) {if (!req.messages.some(m=>m.role==='tool')) {yield {type:'tool_call',id:'capture-1',name:'image-fixture__capture',args:{}};} else {yield {type:'text',text:req.messages.some(m=>m.images?.some(i=>i.mime==='image/png'&&i.data===${JSON.stringify(PNG)}))?'pixels_received':'pixels_missing'};} yield {type:'done',usage:{inputTokens:10,outputTokens:2}}; }}); } };`);
  const sinty = await boot(home, [], { plugins: ["image-provider-fixture", "image-fixture"], config: { providers: { fake: { protocol: "synthetic-image-reader" } } }, policy: policySchema.parse({ defaults: { external: "allow" } }) });
  try {
    const session = sinty.agent.createSession(); sinty.agent.send(session.id, "synthetic screenshot"); await sinty.agent.idle();
    const events = sinty.journal.events(session.id); const completed = events.find((e) => e.type === "tool.call.completed") as SintyEvent<"tool.call.completed">;
    assert.ok(completed); assert.equal(completed.data.blobs?.length, 1); assert.ok(!JSON.stringify(events).includes(PNG), "no journal event stores the inline image bytes");
    const messages = eventsToMessages(events, sinty.paths.data); assert.ok(messages.some((m) => m.images?.[0]?.data === PNG));
    const responses = events.filter((e): e is SintyEvent<"model.response"> => e.type === "model.response");
    assert.equal(responses.at(-1)?.data.text, "pixels_received", "the real core context and provider IPC deliver image bytes, not just standalone replay");

  } finally { await sinty.stop(); }
});
