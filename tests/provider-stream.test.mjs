import test from 'node:test';
import assert from 'node:assert/strict';
import compat from '../plugins/provider-openai-compat/dist/index.js';
import native from '../plugins/provider-anthropic/dist/index.js';
import responses from '../plugins/provider-openai-responses/dist/index.js';
import { Agent } from '../packages/core/dist/agent.js';
import { validateProviderCalls, StreamDiagnostics, readStreamDiagnostic, ProviderStreamError } from '../packages/sdk/dist/index.js';

// All transports are fixtures. An accidental unmocked request is an immediate failure.
globalThis.fetch = () => { throw new Error('LIVE NETWORK FORBIDDEN'); };
const schema = { type: 'object', properties: { path: { type: 'string' }, x: { type: 'number' } }, additionalProperties: false };
const tools = ['fs__read', 'fs__write', 'aaaa'].map(name => ({ name, description: 'fixture', inputSchema: schema }));
const tc = (index, name, args, id) => ({ index, ...(id !== undefined ? { id } : {}), function: { ...(name !== undefined ? { name } : {}), ...(args !== undefined ? { arguments: args } : {}) } });
const delta = (...calls) => ({ choices: [{ index: 0, delta: { tool_calls: calls } }] });
const finish = { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
const normal = [delta(tc(0, 'fs__read', '{"path":', 'a')), delta(tc(0, undefined, '"fixture"}')), finish, '[DONE]'];
const repeated = [delta(tc(0, 'fs__read', '{"path":', 'a')), delta(tc(0, 'fs__read', '"fixture"', 'a')), delta(tc(0, 'fs__read', '}', 'a')), finish, '[DONE]'];
const nativeEvents = [
  { type: 'message_start', message: { usage: { input_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'fs__read', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"fixture"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];
const item = (index = 0, id = 'item-a', callId = 'a', args = '{}') => ({ type: 'response.output_item.done', output_index: index, item: { type: 'function_call', status: 'completed', id, call_id: callId, name: 'fs__read', arguments: args } });
const completed = { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } };

async function run(def, events, opts = {}) {
  let provider, wire, fetched = 0;
  const controller = opts.controller ?? new AbortController();
  def.setup({ provider: p => { provider = p; }, net: { fetch: async (_url, init) => {
    fetched++; wire = JSON.parse(init.body);
    const encoded = new TextEncoder().encode(events.map(x => 'data: ' + (typeof x === 'string' ? x : JSON.stringify(x)) + '\n\n').join(''));
    const pieces = opts.oneByte ? [...encoded].map(x => Uint8Array.of(x)) : [encoded];
    let at = 0;
    return new Response(new ReadableStream({ pull(c) {
      if (at < pieces.length) c.enqueue(pieces[at++]);
      else if (opts.transportError) c.error(new Error('fixture transport error'));
      else c.close();
    } }));
  } } });
  const chunks = []; let error;
  try {
    for await (const c of provider.stream({ endpoint: { baseUrl: 'https://fixture.invalid', options: opts.options }, model: 'fixture', messages: [{ role: 'user', content: 'fixture' }], tools: opts.tools ?? tools, signal: controller.signal })) {
      chunks.push(c); if (opts.abortOnText && c.type === 'text') controller.abort();
    }
  } catch (e) { error = e; }
  return { chunks, error, wire, fetched };
}
const emitted = r => r.chunks.filter(c => c.type === 'tool_call');
function rejected(r, reason) {
  assert.ok(r.error, 'must reject rather than silently finish');
  if (reason) assert.match(r.error.message, new RegExp(reason));
  assert.equal(emitted(r).length, 0, 'no provisional call may escape failed transport');
  assert.equal(r.chunks.some(c => c.type === 'done'), false);
}

test('compat DeepSeek-style name once + argument deltas', async () => {
  const r = await run(compat, normal); assert.ifError(r.error);
  assert.deepEqual(emitted(r), [{ type: 'tool_call', id: 'a', name: 'fs__read', args: { path: 'fixture' } }]);
});
test('compat legitimate name fragments, including equal adjacent fragments', async () => {
  for (const [names, expected] of [[['fs', '__', 'read'], 'fs__read'], [['aa', 'aa'], 'aaaa']]) {
    const r = await run(compat, [...names.map((name, i) => delta(tc(0, name, i === 0 ? '{}' : undefined, 'a'))), finish, '[DONE]']);
    assert.ifError(r.error); assert.equal(emitted(r)[0].name, expected);
  }
});
test('compat repeated complete metadata is NOT guessed in default delta mode', async () => {
  rejected(await run(compat, repeated), 'unadvertised_tool');
});
test('compat explicit metadata contract accepts consistent complete names, without forwarding local options', async () => {
  const r = await run(compat, repeated, { options: { toolCallNameMode: 'metadata', streamDiagnostics: true } });
  assert.ifError(r.error); assert.equal(emitted(r)[0].name, 'fs__read');
  assert.equal(r.wire.toolCallNameMode, undefined); assert.equal(r.wire.streamDiagnostics, undefined);
});
test('compat metadata mode refuses fragments / changed snapshot and invalid mode', async () => {
  rejected(await run(compat, [delta(tc(0, 'fs__', '', 'a')), delta(tc(0, 'fs__read', '{}')), finish, '[DONE]'], { options: { toolCallNameMode: 'metadata' } }), 'conflicting_name_metadata');
  rejected(await run(compat, normal, { options: { toolCallNameMode: 'guess' } }), 'invalid_name_mode');
});
test('compat parallel indices stay independent and sorted', async () => {
  const r = await run(compat, [delta(tc(1, 'fs__write', '{"x":', 'b'), tc(0, 'fs__read', '{"path":', 'a')), delta(tc(0, undefined, '"fixture"}'), tc(1, undefined, '1}')), finish, '[DONE]']);
  assert.ifError(r.error); assert.deepEqual(emitted(r).map(c => [c.id, c.name, c.args]), [['a', 'fs__read', { path: 'fixture' }], ['b', 'fs__write', { x: 1 }]]);
});
const compatBad = [
  ['ID replacement', [delta(tc(0, 'fs__read', '', 'a')), delta(tc(0, undefined, '{}', 'b')), finish, '[DONE]'], 'conflicting_call_id'],
  ['duplicate IDs across indices', [delta(tc(0, 'fs__read', '{}', 'a'), tc(1, 'fs__write', '{}', 'a')), finish, '[DONE]'], 'duplicate_call_id'],
  ['missing index', [delta(tc(undefined, 'fs__read', '{}', 'a')), finish, '[DONE]'], 'invalid_tool_index'],
  ['negative index', [delta(tc(-1, 'fs__read', '{}', 'a')), finish, '[DONE]'], 'invalid_tool_index'],
  ['same index twice in a frame', [delta(tc(0, 'fs__read', '{}', 'a'), tc(0, undefined, '', 'a')), finish, '[DONE]'], 'invalid_tool_index'],
  ['missing ID', [delta(tc(0, 'fs__read', '{}')), finish, '[DONE]'], 'invalid_identity'],
  ['cumulative argument snapshots', [delta(tc(0, 'fs__read', '{"path":"a"}', 'a')), delta(tc(0, undefined, '{"path":"ab"}')), finish, '[DONE]'], 'invalid_json'],
  ['cumulative names', [delta(tc(0, 'fs__', '', 'a')), delta(tc(0, 'fs__read', '{}')), finish, '[DONE]'], 'unadvertised_tool'],
  ['multiple choices', [{ choices: [{ index: 0, delta: {} }, { index: 1, delta: {} }] }, finish, '[DONE]'], 'multiple_choices'],
  ['choice 1 only', [{ choices: [{ index: 1, delta: {} }] }, finish, '[DONE]'], 'multiple_choices'],
  ['EOF', normal.slice(0, 2), 'missing_terminal'],
  ['finish without DONE', normal.slice(0, 3), 'missing_terminal'],
  ['DONE without finish', [...normal.slice(0, 2), '[DONE]'], 'missing_terminal'],
  ['truncated args', [delta(tc(0, 'fs__read', '{"path":', 'a')), finish, '[DONE]'], 'invalid_json'],
  ['array args', [delta(tc(0, 'fs__read', '[]', 'a')), finish, '[DONE]'], 'arguments_not_json_object'],
  ['null args', [delta(tc(0, 'fs__read', 'null', 'a')), finish, '[DONE]'], 'arguments_not_json_object'],
  ['empty args', [delta(tc(0, 'fs__read', '', 'a')), finish, '[DONE]'], 'invalid_json'],
  ['wrong schema', [delta(tc(0, 'fs__read', '{"path":7}', 'a')), finish, '[DONE]'], 'invalid_arguments'],
  ['unknown tool', [delta(tc(0, 'not_advertised', '{}', 'a')), finish, '[DONE]'], 'unadvertised_tool'],
  ['length finish with calls', [normal[0], normal[1], { choices: [{ finish_reason: 'length' }] }, '[DONE]'], 'incomplete_tool_calls'],
  ['stop finish with calls', [normal[0], normal[1], { choices: [{ finish_reason: 'stop' }] }, '[DONE]'], 'incomplete_tool_calls'],
  ['upstream error', [normal[0], { error: { message: 'PRIVATE_PROVIDER_PAYLOAD' } }], 'upstream_stream_error'],
  ['invalid SSE JSON', [normal[0], '{PRIVATE_INVALID_JSON'], 'invalid_json'],
  ['tool data after finish', [normal[0], normal[1], finish, delta(tc(0, undefined, '{}')), '[DONE]'], 'data_after_finish'],
];
for (const [label, events, reason] of compatBad) test('compat rejects ' + label, async () => rejected(await run(compat, events), reason));
test('compat transport exception and abort never release buffered calls', async () => {
  rejected(await run(compat, normal.slice(0, 3), { transportError: true }));
  const ac = new AbortController(); ac.abort(); rejected(await run(compat, normal, { controller: ac }));
  rejected(await run(compat, [{ choices: [{ delta: { content: 'fixture' } }] }, ...normal], { abortOnText: true }));
});
test('compat UTF8/SSE byte boundaries and fresh requests', async () => {
  const r = await run(compat, [{ choices: [{ delta: { content: 'Привет' } }] }, ...normal], { oneByte: true });
  assert.ifError(r.error); assert.equal(r.chunks.filter(c => c.type === 'text').map(c => c.text).join(''), 'Привет');
  for (let i = 0; i < 2; i++) { const next = await run(compat, normal); assert.ifError(next.error); assert.equal(emitted(next).length, 1); }
});
test('diagnostics opt-in, bounded, and never include attacker names/IDs/args/prompts', async () => {
  const secret = 'PRIVATE_SENTINEL_BEARER_TOKEN';
  const events = [delta(tc(0, secret, JSON.stringify({ path: secret }), secret)), finish, '[DONE]'];
  const plain = await run(compat, events); assert.equal(plain.error.hint, undefined);
  const diagnostic = await run(compat, events, { options: { streamDiagnostics: true } });
  assert.ok(diagnostic.error.hint); assert.ok(!JSON.stringify({ message: diagnostic.error.message, hint: diagnostic.error.hint }).includes(secret));
  assert.equal(JSON.parse(diagnostic.error.hint).terminal, true);
  const d = new StreamDiagnostics(true); for (let i = 0; i < 1000; i++) d.call(i, secret, secret, secret);
  assert.equal(JSON.parse(d.error('fixture').hint).calls.length, 16); assert.ok(d.error('fixture').hint.length < 3000);
});

test('native tool blocks complete before message_stop and retain initial object', async () => {
  const r = await run(native, nativeEvents); assert.ifError(r.error); assert.equal(emitted(r)[0].args.path, 'fixture');
  const init = structuredClone(nativeEvents); init[1].content_block.input = { path: 'initial' }; init.splice(2, 1);
  const r2 = await run(native, init); assert.ifError(r2.error); assert.equal(emitted(r2)[0].args.path, 'initial');
});
const nativeBad = [
  ['repeated block start', [nativeEvents[0], nativeEvents[1], nativeEvents[1], ...nativeEvents.slice(2)]],
  ['EOF without message_stop', nativeEvents.slice(0, -1)],
  ['unfinished block', [nativeEvents[0], nativeEvents[1], nativeEvents[4], nativeEvents[5]]],
  ['missing index', [nativeEvents[0], { ...nativeEvents[1], index: undefined }, ...nativeEvents.slice(2)]],
  ['unknown delta index', [nativeEvents[0], { ...nativeEvents[2], index: 5 }, ...nativeEvents.slice(3)]],
  ['invalid JSON', [nativeEvents[0], nativeEvents[1], { ...nativeEvents[2], delta: { type: 'input_json_delta', partial_json: '{' } }, ...nativeEvents.slice(3)]],
  ['max_tokens with a completed block', [...nativeEvents.slice(0, 4), { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, nativeEvents[5]]],
  ['error after completed block', [...nativeEvents.slice(0, 4), { type: 'error', error: { message: 'PRIVATE' } }]],
  ['duplicate tool IDs', [...nativeEvents.slice(0, 4), { ...nativeEvents[1], index: 1 }, { ...nativeEvents[2], index: 1 }, { ...nativeEvents[3], index: 1 }, ...nativeEvents.slice(4)]],
];
for (const [label, events] of nativeBad) test('native rejects ' + label, async () => rejected(await run(native, events)));
test('native error/transport abort after block stop never exposes call', async () => {
  rejected(await run(native, nativeEvents.slice(0, 4), { transportError: true }));
  const ac = new AbortController(); ac.abort(); rejected(await run(native, nativeEvents, { controller: ac }));
});

test('Responses completed full argument snapshot (not a delta)', async () => {
  const r = await run(responses, [item(0, 'item-a', 'a', '{"path":"fixture"}'), completed]); assert.ifError(r.error);
  assert.deepEqual(emitted(r)[0].args, { path: 'fixture' });
});
const responsesBad = [
  ['duplicate done item', [item(), item(), completed]],
  ['conflicting output index', [item(), item(0, 'item-b', 'b'), completed]],
  ['duplicate call ID', [item(), item(1, 'item-b', 'a'), completed]],
  ['duplicate item ID', [item(), item(1, 'item-a', 'b'), completed]],
  ['missing output index', [{ ...item(), output_index: undefined }, completed]],
  ['missing terminal', [item()]],
  ['incomplete', [item(), { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]],
  ['failed', [item(), { type: 'response.failed', response: { error: { message: 'PRIVATE' } } }]],
  ['invalid JSON', [item(0, 'item-a', 'a', '{'), completed]],
  ['array JSON', [item(0, 'item-a', 'a', '[]'), completed]],
  ['missing call ID', [{ ...item(), item: { ...item().item, call_id: undefined } }, completed]],
];
for (const [label, events] of responsesBad) test('Responses rejects ' + label, async () => rejected(await run(responses, events)));

function fakeAgent(factory) {
  const agent = Object.create(Agent.prototype), events = [], live = [];
  agent.d = { config: { models: { default: 'fixture/primary', fallback: [], maxOutputTokens: 100 }, providers: { fixture: { protocol: 'openai-compat' } }, supervisor: { budget: { count: 'all', cachedWeight: 0.1 } } }, secrets: { resolve: () => undefined }, host: { inspectors: () => [], providerFor: () => ({ streamProvider: (_p, req, signal) => factory(req, signal) }) }, journal: { turnEvents: () => events }, bus: { publish: e => live.push(e) } };
  agent.speaker = () => undefined; agent.buildContext = async () => [{ role: 'user', content: 'fixture' }];
  agent.allowedTools = () => undefined; agent.toolSchemas = () => tools; agent.pluginVisible = () => true;
  agent.allTools = () => [{ name: 'fs.read' }, { name: 'fs.write' }];
  agent.lastPrompt = new Map(); agent.ratios = new Map(); agent.record = e => { events.push(structuredClone(e)); return e; };
  agent.fitWindow = (_s, _r, messages, _t, estTokens) => ({ ok: true, messages, estTokens });
  return { agent, events, live };
}
const call = { type: 'tool_call', id: 'a', name: 'fs__read', args: {} };
const done = { type: 'done', stopReason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } };
async function coreReject(chunks, opts = {}) {
  const f = fakeAgent(async function* () { yield* chunks; if (opts.error) throw Error('fixture'); });
  if (opts.prior) f.events.push({ type: 'model.response', data: { toolCalls: [{ callId: 'a', tool: 'fs.read', args: {} }] } });
  const before = f.events.length;
  const ac = new AbortController(); if (opts.abort) ac.abort();
  await assert.rejects(f.agent.callModel('fixture', 'fixture', ac.signal));
  assert.equal(f.events.slice(before).some(e => e.type === 'model.response' || e.type === 'tool.call.requested'), false);
}
test('core accepts exact wire catalog then maps name, only after completed stream', async () => {
  const f = fakeAgent(async function* () { yield call; assert.equal(f.events.some(e => e.type === 'tool.call.requested'), false); yield done; });
  await f.agent.callModel('fixture', 'fixture', new AbortController().signal);
  assert.equal(f.events.find(e => e.type === 'model.response').data.toolCalls[0].tool, 'fs.read');
});
const coreBad = [
  ['EOF', [call]], ['duplicate ID', [call, call, done]], ['no ID', [{ ...call, id: '' }, done]],
  ['unadvertised', [{ ...call, name: 'fs__readfs__read' }, done]], ['invalid schema', [{ ...call, args: { path: 7 } }, done]],
  ['invalid args object', [{ ...call, args: [] }, done]], ['duplicate terminal', [call, done, done]],
  ['data after terminal', [done, call]], ['truncation', [call, { ...done, stopReason: 'length' }]],
];
for (const [label, chunks] of coreBad) test('core rejects before executable journal: ' + label, async () => coreReject(chunks));
test('core error/abort and previously used turn IDs never create executable calls', async () => {
  await coreReject([call, done], { error: true }); await coreReject([call, done], { abort: true }); await coreReject([call, done], { prior: true });
});
test('core checks the advertised allowed/visible subset, not merely installed catalog', async () => {
  const f = fakeAgent(async function* () { yield call; yield done; }); f.agent.allowedTools = () => ['fs.write'];
  await assert.rejects(f.agent.callModel('fixture', 'fixture', new AbortController().signal));
  assert.equal(f.events.some(e => e.type === 'model.response'), false);
});
test('core fallback attempts have isolated text/call/terminal buffers', async () => {
  const f = fakeAgent(async function* (req) { if (req.model === 'primary') { yield { type: 'text', text: 'failed' }; yield call; throw Error('fixture'); } yield { type: 'text', text: 'backup' }; yield call; yield done; });
  f.agent.d.config.models.fallback = ['fixture/backup'];
  await f.agent.callModel('fixture', 'fixture', new AbortController().signal);
  const r = f.events.find(e => e.type === 'model.response'); assert.equal(r.data.text, 'backup'); assert.equal(r.data.toolCalls.length, 1);
});
test('recovered malformed/duplicate calls fail before policy, approval, dispatch', async () => {
  for (const duplicate of [false, true]) {
    const f = fakeAgent(async function* () {});
    const historical = { callId: 'a', tool: 'fs.read', args: duplicate ? {} : { path: 7 } };
    f.events.push({ type: 'model.response', data: { toolCalls: duplicate ? [historical, historical] : [historical], stopReason: 'tool_calls' } });
    if (duplicate) await assert.rejects(f.agent.processCall('fixture', 'fixture', 'step', historical, { kind: 'new' }, new AbortController().signal), /duplicate_call_id/);
    else {
      await f.agent.processCall('fixture', 'fixture', 'step', historical, { kind: 'new' }, new AbortController().signal);
      assert.equal(f.events.at(-1).type, 'tool.call.failed'); assert.equal(f.events.at(-1).data.code, 'provider_protocol_error');
      assert.match(f.events.at(-1).data.message, /invalid_arguments/);
    }
    assert.equal(f.events.some(e => e.type === 'tool.call.started'), false);
  }
});
test('batch schema validation: required, additionalProperties, JSON-only, unsupported schema fail closed', () => {
  const c = { id: 'a', name: 'fs__read', args: {} };
  assert.throws(() => validateProviderCalls([c], [{ ...tools[0], inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]));
  assert.throws(() => validateProviderCalls([{ ...c, args: { extra: true } }], tools));
  assert.throws(() => validateProviderCalls([{ ...c, args: { x: NaN } }], tools));
  assert.throws(() => validateProviderCalls([c], [{ ...tools[0], inputSchema: { type: 'object', $ref: 'https://fixture.invalid/never-fetch.json' } }]), /unsupported_argument_schema/);
});


test('required/default semantics are JSON Schema, not permissive Zod conversion', () => {
  const c = { id: 'a', name: 'fs__read', args: {} };
  for (const inputSchema of [
    { type: 'object', required: ['path'] },
    { properties: { path: { type: 'string' } }, required: ['path'] },
    { type: 'object', properties: { path: { type: 'string', default: 'default-is-only-annotation' } }, required: ['path'] },
  ]) assert.throws(() => validateProviderCalls([c], [{ ...tools[0], inputSchema }]), /invalid_arguments/);
  const inputSchema = { type: 'object', properties: { path: { type: 'string', default: 'x' } } };
  validateProviderCalls([c], [{ ...tools[0], inputSchema }]); assert.deepEqual(c.args, {}, 'no defaults/coercion/removal');
});
test('JSON Schema dialects, refs, not, formats, async schemas', () => {
  const c = { id: 'a', name: 'fs__read', args: { path: 'fixture' } };
  for (const $schema of ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema']) {
    validateProviderCalls([c], [{ ...tools[0], inputSchema: { $schema, type: 'object', properties: { path: { $ref: '#/$defs/p' } }, required: ['path'], $defs: { p: { type: 'string' } } } }]);
  }
  assert.throws(() => validateProviderCalls([c], [{ ...tools[0], inputSchema: { type: 'object', not: { required: ['path'] } } }]), /invalid_arguments/);
  assert.throws(() => validateProviderCalls([c], [{ ...tools[0], inputSchema: { type: 'object', properties: { path: { type: 'string', format: 'email' } } } }]), /invalid_arguments/);
  assert.throws(() => validateProviderCalls([c], [{ ...tools[0], inputSchema: { $async: true, type: 'object' } }]), /unsupported_argument_schema/);
});
test('currently revoked child tools, visibility and deny policy block approved calls', async () => {
  for (const mode of ['allowed', 'visible', 'policy', 'path']) {
    const f = fakeAgent(async function* () {});
    const historical = { callId: 'a', tool: 'fs.read', args: mode === 'path' ? { path: 'secret.txt' } : {} };
    f.agent.d.policy = { tools: mode === 'policy' ? { 'fs.read': 'deny' } : {}, defaults: { read: 'allow' }, agents: {}, paths: mode === 'path' ? [{ pattern: 'secret.txt', access: 'read', decision: 'deny' }] : [] };
    f.agent.allTools = () => [{ name: 'fs.read', sideEffects: 'read' }]; f.agent.sessionWorkspace = () => process.cwd();
    if (mode === 'allowed') f.agent.allowedTools = () => ['fs.write'];
    if (mode === 'visible') f.agent.pluginVisible = () => false;
    await f.agent.processCall('fixture', 'fixture', 'step', historical, { kind: 'approved' }, new AbortController().signal);
    assert.equal(f.events.at(-1).type, 'tool.call.denied'); assert.equal(f.events.some(e => e.type === 'tool.call.started'), false);
  }
});
test('safe diagnostics survive a successful fallback; arbitrary hints are not journaled', async () => {
  for (const badHint of [false, true]) {
    const diag = new StreamDiagnostics(true); diag.frame(); diag.call(0, 'PRIVATE_ID', 'PRIVATE_NAME', 'PRIVATE_ARGS');
    const f = fakeAgent(async function* (req) {
      if (req.model === 'primary') throw new ProviderStreamError('invalid_json', badHint ? '{"PRIVATE":"SENSITIVE"}' : diag.error('invalid_json').hint);
      yield done;
    });
    f.agent.d.config.providers.fixture.options = { streamDiagnostics: true };
    f.agent.d.config.models.fallback = ['fixture/backup'];
    await f.agent.callModel('fixture', 'fixture', new AbortController().signal);
    const e = f.events.find(e => e.type === 'model.stream_error'); assert.ok(e); assert.equal(e.data.attempt, 0);
    assert.equal(Boolean(e.data.diagnostics), !badHint); assert.equal(JSON.stringify(e).includes('PRIVATE'), false);
    assert.equal(readStreamDiagnostic('{"version":1,"PRIVATE":"SENSITIVE"}'), undefined);
  }
});
test('all adapters preserve valid text-only terminals, and pre-abort does not fetch', async () => {
  for (const [def, events] of [
    [compat, [{ choices: [{ delta: { content: 'fixture' }, finish_reason: 'stop' }] }, '[DONE]']],
    [native, [{ type: 'message_start' }, { type: 'content_block_start', index: 0, content_block: { type: 'text' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]],
    [responses, [{ type: 'response.output_text.delta', delta: 'fixture' }, completed]],
  ]) {
    const r = await run(def, events); assert.ifError(r.error); assert.equal(r.chunks.at(-1).type, 'done');
    const ac = new AbortController(); ac.abort(); const aborted = await run(def, events, { controller: ac }); rejected(aborted); assert.equal(aborted.fetched, 0);
  }
  const text = await run(responses, [{ type: 'response.output_text.delta', delta: 'partial fixture' }, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]);
  assert.ifError(text.error); assert.equal(text.chunks.at(-1).stopReason, 'length'); assert.equal(emitted(text).length, 0);
});
test('Responses authoritative completed output must agree, not merge snapshots', async () => {
  const good = { type: 'response.completed', response: { ...completed.response, output: [item().item] } };
  assert.ifError((await run(responses, [item(), good])).error);
  rejected(await run(responses, [item(), { type: 'response.completed', response: { output: [{ ...item().item, call_id: 'changed' }] } }]));
  rejected(await run(responses, [good]));
  rejected(await run(responses, [item(), { type: 'response.completed', response: { output: [] } }]));
});


test('canonical names come from exact advertised registry, not underscore guessing', async () => {
  const f = fakeAgent(async function* () { yield { ...call, name: 'plugin__literal' }; yield done; });
  f.agent.allTools = () => [{ name: 'plugin__literal' }];
  f.agent.toolSchemas = () => [{ ...tools[0], name: 'plugin__literal' }];
  await f.agent.callModel('fixture', 'fixture', new AbortController().signal);
  assert.equal(f.events.find(e => e.type === 'model.response').data.toolCalls[0].tool, 'plugin__literal');
});
test('ambiguous wire encoding cannot silently select a tool', async () => {
  const f = fakeAgent(async function* () { yield call; yield done; });
  f.agent.toolSchemas = () => [tools[0], tools[0]];
  await assert.rejects(f.agent.callModel('fixture', 'fixture', new AbortController().signal));
  assert.equal(f.events.some(e => e.type === 'model.response'), false);
});
test('old journal partial/truncated responses and invalid-JSON sentinels never dispatch', async () => {
  for (const mode of ['length', 'partial', 'sentinel']) {
    const f = fakeAgent(async function* () {});
    const historical = { callId: 'a', tool: 'fs.read', args: mode === 'sentinel' ? { __invalid_json: '{PRIVATE' } : {} };
    f.agent.toolSchemas = () => [{ ...tools[0], inputSchema: { type: 'object' } }];
    f.events.push({ type: 'model.response', data: { toolCalls: [historical], stopReason: mode === 'length' ? 'length' : 'tool_calls', ...(mode === 'partial' ? { partial: true } : {}) } });
    await f.agent.processCall('fixture', 'fixture', 'step', historical, { kind: 'new' }, new AbortController().signal);
    assert.equal(f.events.at(-1).type, 'tool.call.failed'); assert.equal(f.events.at(-1).data.code, 'provider_protocol_error');
    assert.equal(f.events.some(e => e.type === 'tool.call.started'), false);
  }
});
test('core rejects invalid chunk envelopes and non-finite usage', async () => {
  await coreReject([call, { ...done, usage: { inputTokens: NaN, outputTokens: 1 } }]);
  await coreReject([call, { type: 'unknown_chunk' }, done]);
  await coreReject([{ type: 'text', text: { private: 'fixture' } }, call, done]);
});
test('core Zod-generated tool schemas compile without weakening validation', async () => {
  const { CORE_TOOLS, coreToolSchema } = await import('../packages/core/dist/coretools.js');
  for (const t of CORE_TOOLS) {
    try { validateProviderCalls([{ id: 'a', name: t.name, args: {} }], [{ name: t.name, description: t.description, inputSchema: coreToolSchema(t) }]); }
    catch (e) { assert.match(e.message, /invalid_arguments/, 'unsupported core schema: ' + t.name + ': ' + e.message); }
  }
});


test('one invalid call rejects the entire batch in adapters and core', async () => {
  rejected(await run(compat, [delta(tc(0, 'fs__read', '{}', 'a'), tc(1, 'fs__write', '{"x":"wrong"}', 'b')), finish, '[DONE]']));
  rejected(await run(responses, [item(), item(1, 'item-b', 'b', '{'), completed]));
  await coreReject([call, { ...call, id: 'b', args: { path: 7 } }, done]);
});
test('explicit provisional flag is not an SDK completed call', async () => {
  await coreReject([{ ...call, partial: true }, done]);
});
test('aborted dispatch and abort after done cannot start a tool', async () => {
  const ac = new AbortController(); ac.abort(); const f = fakeAgent(async function* () {});
  await assert.rejects(f.agent.processCall('fixture', 'fixture', 'step', { callId: 'a', tool: 'fs.read', args: {} }, { kind: 'approved' }, ac.signal));
  assert.equal(f.events.length, 0);
  const end = new AbortController(); const f2 = fakeAgent(async function* () { yield call; yield done; end.abort(); });
  await assert.rejects(f2.agent.callModel('fixture', 'fixture', end.signal));
  assert.equal(f2.events.some(e => e.type === 'model.response'), false);
});
test('dispatch gate is repeated at execute after asynchronous recovery/permission changes', async () => {
  const f = fakeAgent(async function* () {}); f.agent.allowedTools = () => ['fs.write'];
  await f.agent.execute('fixture', 'fixture', 'step', { callId: 'a', tool: 'fs.read', args: {} }, { name: 'fs.read' }, new AbortController().signal, true);
  assert.equal(f.events.at(-1).type, 'tool.call.denied'); assert.equal(f.events.some(e => e.type === 'tool.call.started'), false);
});
test('recovered ambiguous identities fail the turn once, instead of unresolved-ID loops', async () => {
  for (const id of ['a', '']) {
    const f = fakeAgent(async function* () {});
    const historical = { callId: id, tool: 'fs.read', args: {} };
    f.events.push({ type: 'model.response', data: { toolCalls: [historical, historical], stopReason: 'tool_calls' } });
    f.agent.view = () => ({ calls: [{ call: historical, status: { kind: 'new' } }], lastResponse: { stepId: 'step', data: { toolCalls: [historical, historical], stopReason: 'tool_calls' } } });
    f.agent.canRunTogether = () => false;
    f.agent.guardStall = async (_s, _t, signal, fn) => fn(signal);
    f.agent.endTurn = (_s, _t, _status, event) => f.events.push(event);
    await f.agent.advance('fixture', 'fixture', new AbortController().signal);
    assert.equal(f.events.at(-1).type, 'turn.failed');
    assert.equal(f.events.at(-1).data.code, 'provider_protocol_error');
    assert.match(f.events.at(-1).data.message, new RegExp(id ? 'duplicate_call_id' : 'invalid_identity|duplicate_call_id'));
    assert.ok(f.events.length < 5); assert.equal(f.events.some(e => e.type === 'tool.call.started'), false);
  }
});


test('Responses added/progress/done identities cannot change or mix', async () => {
  const start = { ...item(), type: 'response.output_item.added', item: { ...item().item, arguments: '' } };
  const progress = { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item-a', delta: '{' };
  const good = await run(responses, [start, progress, item(), completed]); assert.ifError(good.error);
  for (const events of [
    [start, start, item(), completed],
    [start, { ...item(), item: { ...item().item, id: 'changed-item' } }, completed],
    [start, { ...item(), item: { ...item().item, call_id: 'changed-call' } }, completed],
    [start, { ...item(), item: { ...item().item, name: 'fs__write' } }, completed],
    [start, { ...progress, item_id: 'changed-item' }, item(), completed],
    [item(), progress, completed],
    [{ ...item(), item: { ...item().item, id: 7 } }, completed],
  ]) rejected(await run(responses, events));
});


test('literal underscore wire names cannot bypass a canonical child allow-list', async () => {
  const f = fakeAgent(async function* () { yield { ...call, name: 'plugin__literal' }; yield done; });
  f.agent.allTools = () => [{ name: 'plugin__literal' }]; f.agent.toolSchemas = () => [{ ...tools[0], name: 'plugin__literal' }]; f.agent.allowedTools = () => ['plugin.literal'];
  await assert.rejects(f.agent.callModel('fixture', 'fixture', new AbortController().signal));
  assert.equal(f.events.some(e => e.type === 'model.response'), false);
});
test('recovery validates a bad batch before any valid parallel companion can dispatch', async () => {
  const f = fakeAgent(async function* () {});
  const valid = { callId: 'a', tool: 'fs.read', args: {} }, invalid = { callId: 'b', tool: 'fs.write', args: { x: 'wrong' } };
  const data = { toolCalls: [valid, invalid], stopReason: 'tool_calls' };
  f.events.push({ type: 'model.response', data });
  f.agent.view = () => ({ calls: [valid, invalid].map(call => ({ call, status: { kind: 'new' } })), lastResponse: { stepId: 'step', data } });
  let dispatched = 0; f.agent.processCall = async () => { dispatched++; return 'done'; };
  f.agent.endTurn = (_s, _t, _status, event) => f.events.push(event);
  await f.agent.advance('fixture', 'fixture', new AbortController().signal);
  assert.equal(dispatched, 0); assert.equal(f.events.at(-1).type, 'turn.failed'); assert.match(f.events.at(-1).data.message, /invalid_arguments/);
});
test('valid upstream errors retain their error class/retryability without echoing payloads', async () => {
  const n = await run(native, [{ type: 'error', error: { type: 'overloaded_error', message: 'PRIVATE_SENTINEL' } }]);
  rejected(n); assert.equal(n.error.code, 'overloaded_error'); assert.equal(n.error.retryable, true); assert.ok(!n.error.message.includes('PRIVATE'));
  const r = await run(responses, [{ type: 'error', code: 'server_error', message: 'PRIVATE_SENTINEL' }]);
  rejected(r); assert.equal(r.error.code, 'provider_error'); assert.equal(r.error.retryable, true);
});


test('compiled-schema cache never reuses a decision for changed or mutated schemas', () => {
  const original = { type: 'object', properties: { path: { enum: ['original'] } } };
  const c = { id: 'a', name: 'fs__read', args: { path: 'original' } };
  validateProviderCalls([c], [{ ...tools[0], inputSchema: original }]);
  original.properties.path.enum.push('mutated');
  assert.throws(() => validateProviderCalls([{ ...c, args: { path: 'mutated' } }], [{ ...tools[0], inputSchema: { type: 'object', properties: { path: { enum: ['original'] } } } }]), /invalid_arguments/);
  validateProviderCalls([{ ...c, args: { path: 'mutated' } }], [{ ...tools[0], inputSchema: original }]);
  assert.throws(() => validateProviderCalls([c], [{ ...tools[0], inputSchema: { type: 'object', properties: { path: { type: 'number' } } } }]), /invalid_arguments/);
});


test('Responses announced function calls cannot disappear into a text-only completion', async () => {
  const start = { ...item(), type: 'response.output_item.added' };
  const progress = { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item-a', delta: '{' };
  rejected(await run(responses, [start, completed]));
  rejected(await run(responses, [progress, completed]));
  rejected(await run(responses, [start, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]));
  rejected(await run(responses, [item(), { type: 'response.completed', response: { output: [{ ...item().item, status: 'in_progress' }] } }]));
});
