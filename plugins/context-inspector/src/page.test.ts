import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { TAB_HTML } from "./page.js";

/** Just enough DOM for the page script: elements with text, children, class and listeners. */
class FakeEl {
  children: (FakeEl | { text: string })[] = [];
  className = "";
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  checked = true;
  own = "";
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  constructor(readonly tag: string) {}
  set textContent(v: string) {
    this.own = v;
    this.children = [];
  }
  get textContent(): string {
    return this.own + this.children.map((c) => (c instanceof FakeEl ? c.textContent : c.text)).join("");
  }
  appendChild(c: FakeEl | { text: string }) {
    this.children.push(c);
    return c;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  click() {
    for (const fn of this.listeners.click ?? []) fn({});
  }
  find(pred: (e: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = [];
    for (const c of this.children) if (c instanceof FakeEl) out.push(...(pred(c) ? [c] : []), ...c.find(pred));
    return out;
  }
}

interface Get {
  id: number;
  path: string;
}

function boot() {
  const ids = ["status", "live", "wrap", "steps", "main"];
  const els = Object.fromEntries(ids.map((id) => [id, new FakeEl("div")])) as Record<string, FakeEl>;
  const sent: Get[] = [];
  const winListeners: ((e: { source: unknown; data: unknown }) => void)[] = [];
  const parent = { postMessage: (_m: { op: string; id: number; path: string }): unknown => undefined };
  const ready: unknown[] = [];
  parent.postMessage = ((m: { op: string; id: number; path: string }) => (m.op === "get" ? sent.push({ id: m.id, path: m.path }) : ready.push(m))) as typeof parent.postMessage;
  const doc = {
    hidden: false,
    documentElement: { dataset: {} as Record<string, string> },
    getElementById: (id: string) => els[id],
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (text: string) => ({ text }),
  };
  const script = TAB_HTML.slice(TAB_HTML.indexOf("<script>") + 8, TAB_HTML.indexOf("</script>"));
  const timers: (() => void)[] = [];
  runInNewContext(script, {
    document: doc,
    parent,
    addEventListener: (_t: string, fn: (e: { source: unknown; data: unknown }) => void) => winListeners.push(fn),
    setTimeout: () => 0,
    setInterval: (fn: () => void) => timers.push(fn),
    Promise,
    Date,
    JSON,
    Object,
    Math,
    String,
    Number,
    Error,
  });
  const post = (data: unknown, source: unknown = parent) => winListeners.forEach((fn) => fn({ source, data }));
  const answer = (path: RegExp, data: unknown) => {
    const g = sent.find((x) => path.test(x.path));
    assert.ok(g, `no request for ${path}; sent ${JSON.stringify(sent)}`);
    sent.splice(sent.indexOf(g), 1);
    post({ sinty: "tab/1", id: g.id, ok: true, data });
  };
  const flush = () => new Promise((r) => setImmediate(r));
  return { els, sent, ready, post, answer, flush, tick: () => timers.forEach((t) => t()) };
}

const sum = (id: string, sessionId: string, turnId: string, step: number, total: number) => ({ id, sessionId, turnId, stepId: id, step, at: "2026-10-20T10:00:00.000Z", tokens: { total, messages: total, tools: 0, byKind: { dialogue: total } }, messages: 1, recalled: 0, hooks: 0, contexts: 0, redactions: 0 });
const full = (id: string, sessionId: string) => ({ id, sessionId, turnId: "trn_1", stepId: id, step: 1, at: "2026-10-20T10:00:00.000Z", agentId: "Sinty", messages: [{ role: "user", content: "hi " + id }], parts: [{ index: 0, kind: "dialogue", source: "journal", role: "user", tokens: 3 }], tools: [], tokens: { total: 3, messages: 3, tools: 0, byKind: { dialogue: 3 } }, memory: { facts: [], hooks: [] }, contexts: [], redactions: 0 });

test("session tab page: shows only the open chat, empty state, follows the newest step, switches on op session", async () => {
  const p = boot();
  assert.equal(JSON.stringify(p.ready), JSON.stringify([{ sinty: "tab/1", op: "ready" }]));
  p.tick();
  assert.equal(p.sent.length, 0, "no polling before init");

  // A message from anything but the parent window is ignored.
  p.post({ sinty: "tab/1", op: "init", sessionId: "ses_evil" }, {});
  assert.equal(p.sent.length, 0);

  p.post({ sinty: "tab/1", op: "init", theme: "dark", sessionId: "ses_a" });
  assert.deepEqual(p.sent.map((x) => x.path), ["/snapshots?session=ses_a"]);
  p.answer(/ses_a/, { snapshots: [] });
  await p.flush();
  assert.match(p.els.main!.textContent, /снимков пока нет/);
  assert.match(p.els.main!.textContent, /начиная со следующего сообщения/);

  // Live refresh: the first step arrives and opens on its own.
  p.tick();
  p.answer(/ses_a/, { snapshots: [sum("c1", "ses_a", "trn_1", 1, 10)] });
  await p.flush();
  p.answer(/^\/snapshots\/c1$/, full("c1", "ses_a"));
  await p.flush();
  assert.match(p.els.main!.textContent, /hi c1/);
  assert.equal(p.els.wrap!.className, "wrap");

  // A newer step: the view follows it because the latest was selected.
  p.tick();
  p.answer(/ses_a/, { snapshots: [sum("c1", "ses_a", "trn_1", 1, 10), sum("c2", "ses_a", "trn_2", 1, 14)] });
  await p.flush();
  p.answer(/^\/snapshots\/c2$/, full("c2", "ses_a"));
  await p.flush();
  assert.match(p.els.main!.textContent, /hi c2/);
  assert.match(p.els.steps!.textContent, /Ход 2/);

  // Picking an older step pins it: the next refresh does not jump away.
  p.els.steps!.find((e) => e.tag === "button")[0]!.click();
  p.answer(/^\/snapshots\/c1$/, full("c1", "ses_a"));
  await p.flush();
  p.tick();
  p.answer(/ses_a/, { snapshots: [sum("c1", "ses_a", "trn_1", 1, 10), sum("c2", "ses_a", "trn_2", 1, 14), sum("c3", "ses_a", "trn_3", 1, 20)] });
  await p.flush();
  assert.equal(p.sent.length, 0, "stays on the pinned step");
  assert.match(p.els.main!.textContent, /hi c1/);

  // The user switches chats: an answer still in flight for the old chat is dropped.
  p.tick();
  const stale = p.sent.find((x) => /ses_a/.test(x.path))!;
  p.post({ sinty: "tab/1", op: "session", sessionId: "ses_b" });
  p.post({ sinty: "tab/1", id: stale.id, ok: true, data: { snapshots: [sum("c9", "ses_a", "trn_9", 1, 99)] } });
  await p.flush();
  assert.ok(!p.sent.some((x) => x.path === "/snapshots/c9"));
  p.answer(/ses_b/, { snapshots: [sum("b1", "ses_b", "trn_b", 1, 5)] });
  await p.flush();
  p.answer(/^\/snapshots\/b1$/, full("b1", "ses_b"));
  await p.flush();
  assert.match(p.els.main!.textContent, /hi b1/);
  assert.doesNotMatch(p.els.steps!.textContent, /Ход 2/);

  // No chat open.
  p.post({ sinty: "tab/1", op: "session" });
  assert.match(p.els.main!.textContent, /Чат не открыт/);
});

test("session tab page: says where the persona came from and warns when the chat has no agents", async () => {
  for (const [persona, want] of [
    [{ source: "agent", agentName: "Alpha" }, /Персона: AGENTS\.md агента «Alpha»/],
    [{ source: "global" }, /глобальный ~\/\.sinty\/AGENTS\.md — у чата и его проекта нет агентов/],
    [{ source: "global", agentName: "Beta" }, /у агента «Beta» поле AGENTS\.md пустое/],
  ] as const) {
    const p = boot();
    p.post({ sinty: "tab/1", op: "init", sessionId: "ses_p" });
    p.answer(/ses_p/, { snapshots: [sum("p1", "ses_p", "trn_1", 1, 3)] });
    await p.flush();
    p.answer(/^\/snapshots\/p1$/, { ...full("p1", "ses_p"), persona });
    await p.flush();
    assert.match(p.els.main!.textContent, want);
    const warned = p.els.main!.find((e) => e.className === "warn").some((e) => /Персона/.test(e.textContent));
    assert.equal(warned, persona.source === "global" && !("agentName" in persona));
  }
});

test("session tab page: shows real cache usage next to the estimates, the cache boundaries and where the prompt diverged", async () => {
  const p = boot();
  p.post({ sinty: "tab/1", op: "init", sessionId: "ses_c" });
  p.answer(/ses_c/, { snapshots: [{ ...sum("k1", "ses_c", "trn_1", 2, 30), usage: { provider: "deepseek", model: "v4", inputTokens: 1000, outputTokens: 7, cachedTokens: 870, cacheMissTokens: 130 } }] });
  await p.flush();
  assert.match(p.els.steps!.textContent, /кэш 87%/);
  const snapshot = {
    ...full("k1", "ses_c"),
    messages: [{ role: "system", content: "sys" }, { role: "system", content: "skills", cacheHint: "static" }, { role: "user", content: "<turn_context>\nCurrent time: x\n</turn_context>" }, { role: "user", content: "hi", cacheHint: "turn" }],
    parts: [
      { index: 0, kind: "system", source: "core", id: "system", role: "system", tokens: 2 },
      { index: 1, kind: "skills", source: "core", id: "skills", role: "system", tokens: 2, cacheHint: "static" },
      { index: 2, kind: "turn", source: "core", id: "context.turn", role: "user", tokens: 5, blocks: ["memory.recalled"] },
      { index: 3, kind: "dialogue", source: "journal", role: "user", tokens: 2, cacheHint: "turn" },
    ],
    cache: { hints: [{ index: 1, hint: "static" }, { index: 3, hint: "turn" }], cacheable: { messages: 4, tokens: 11 }, reused: { messages: 3, tokens: 9, toolsSame: true, divergedAt: 3 } },
    usage: { provider: "deepseek", model: "v4", inputTokens: 1000, outputTokens: 7, cachedTokens: 870, cacheMissTokens: 130 },
  };
  p.answer(/^\/snapshots\/k1$/, snapshot);
  await p.flush();
  const text = p.els.main!.textContent;
  assert.match(text, /870 · 87%из кэша, факт/);
  assert.match(text, /130мимо кэша, факт/);
  assert.match(text, /11кэшируемый префикс \(оценка\)/);
  assert.match(text, /9совпало с прошлым шагом \(оценка\)/);
  assert.match(text, /граница кэша «static»/);
  assert.match(text, /граница кэша «turn»/);
  assert.match(text, /контекст хода/);
  assert.match(text, /context\.turn \[memory\.recalled\]/);
  const rows = p.els.main!.find((e) => e.className === "div" || e.className === "cut").map((e) => e.className);
  assert.deepEqual(rows, ["cut", "div", "cut"], "boundary after skills, divergence before the last message, boundary after it");
});
