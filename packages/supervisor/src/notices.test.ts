import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EventDataMap, EventType, SintyEvent } from "@sinty/sdk";
import type { Incident, SupervisorAction, SupervisorSettings } from "./protocol.js";
import { docsSection, isCorrection, messageKey, Supervisor, targetOf } from "./supervisor.js";

// Defaults of config.yaml supervisor: (maxNoticesPerDetector 2, maxNoticesPerTurn 6, repeatFailures 2).
const settings: SupervisorSettings = { loopThreshold: 3, maxNoticesPerTurn: 6, maxNoticesPerDetector: 2, docsMaxChars: 500, budget: {} };

const README = `# tool-web

Intro text that is not about any one tool.

## web.search

SEARCH-DOCS: rephrase the query.

## web.read

READ-DOCS: 401/403 is anti-bot protection; try web.interact.

### Errors of web.read

READ-ERRORS: http_4xx, http_5xx.

## web.links

LINKS-DOCS.
`;

let seq = 0;
function ev<T extends EventType>(turnId: string, type: T, data: EventDataMap[T]): SintyEvent {
  return { id: `e${++seq}`, seq, ts: "2026-10-21T13:00:00.000Z", sessionId: "ses_1", turnId, type, actor: { kind: "system", id: "core" }, data } as SintyEvent;
}

/** One model step with one call; `fail` is [code, message, hint?]. */
function call(sup: Supervisor, turnId: string, tool: string, args: unknown, fail?: [string, string, string?]): void {
  const callId = `c${++seq}`;
  sup.onEvent(ev(turnId, "model.response", { toolCalls: [{ callId, tool, args }], stopReason: "tool_use", usage: { provider: "p", model: "m", inputTokens: 10, outputTokens: 5 } }));
  sup.onEvent(ev(turnId, "tool.call.requested", { callId, tool, args }));
  if (fail) sup.onEvent(ev(turnId, "tool.call.failed", { callId, code: fail[0], message: fail[1], ...(fail[2] ? { hint: fail[2] } : {}), durationMs: 1 }));
  else sup.onEvent(ev(turnId, "tool.call.completed", { callId, result: "ok", durationMs: 1 }));
}

function notices(actions: SupervisorAction[]): Extract<SupervisorAction, { type: "notice" }>[] {
  return actions.filter((a): a is Extract<SupervisorAction, { type: "notice" }> => a.type === "notice");
}

function withDocs<T>(run: (docsPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sinty-sup-"));
  try {
    const path = join(dir, "README.md");
    writeFileSync(path, README);
    return run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function webTools(docsPath?: string) {
  return ["web.search", "web.read", "web.interact"].map((name) => ({ name, plugin: "tool-web", sideEffects: "external" as const, editable: true, ...(docsPath ? { docsPath } : {}) }));
}

test("the PS5 turn: site refusals on three different shops never stop the turn and are not incidents", () => {
  withDocs((docs) => {
    const old = { code: "http_4xx", hint: "The site refuses automated requests (anti-bot protection or a login wall)." };
    const stale: Incident = { id: "inc_old", tool: "web.read", code: "http_4xx", message: "page returned 429 (privetpeople.ru)", fixSummary: 'after http_4xx the call worked with arguments {"url":"https://privetpeople.ru/publ/x"}', createdAt: "" };
    const sup = new Supervisor(settings, webTools(docs), [stale]);
    sup.onEvent(ev("t1", "turn.started", { trigger: "message" }));
    const all: SupervisorAction[] = [];
    call(sup, "t1", "web.read", { url: "https://market.yandex.ru/search?text=ps5+pro" }, ["too_large", "response is larger than 1500000 bytes", "The page is larger than the page size limit."]);
    all.push(...sup.checkpoint("t1", "before_model"));
    call(sup, "t1", "web.search", { query: "ps5 pro цена" });
    call(sup, "t1", "web.interact", { url: "https://market.yandex.ru/", actions: [] });
    all.push(...sup.checkpoint("t1", "before_model"));
    call(sup, "t1", "web.read", { url: "https://www.dns-shop.ru/product/ps5-pro/" }, ["http_4xx", "page returned 401 (www.dns-shop.ru)", old.hint]);
    all.push(...sup.checkpoint("t1", "before_model"));
    call(sup, "t1", "web.read", { url: "https://lite-store.ru/ps5-pro" }, ["http_4xx", "page returned 404 (lite-store.ru)", "The page does not exist."]);
    all.push(...sup.checkpoint("t1", "before_model"));
    call(sup, "t1", "web.read", { url: "https://www.mvideo.ru/ps5" }, ["http_5xx", "page returned 503 (www.mvideo.ru)"]);
    all.push(...sup.checkpoint("t1", "before_model"));
    call(sup, "t1", "web.search", { query: "ps5 pro купить" });
    all.push(...sup.checkpoint("t1", "before_model"));

    assert.deepEqual(all.filter((a) => a.type === "escalate"), [], "the turn goes on");
    const ns = notices(all);
    assert.deepEqual(ns.map((n) => n.detector), ["external_error", "external_error"], "two notices, then only the tool results carry hints");
    for (const n of ns) {
      assert.equal(n.level, 1, "different sites are not repeats");
      assert.doesNotMatch(n.text, /Tool docs|READ-DOCS|Intro text/, "no docs for a site that refuses");
      assert.doesNotMatch(n.text, /similar incident|privetpeople/, "no unrelated incident");
      assert.doesNotMatch(n.text, /Private hosts/);
      assert.doesNotMatch(n.text, /failure #/);
    }
    assert.match(ns[0]!.text, /too_large: response is larger than 1500000 bytes/);
    assert.match(ns[1]!.text, /http_4xx: page returned 401 \(www\.dns-shop\.ru\).*\n.*anti-bot/);
    assert.deepEqual(sup.onEvent(ev("t1", "turn.completed", { steps: 6 })), [], "a later read of another page is not a fix");
  });
});

test("external errors on the same site twice say so; tool errors still escalate as before", () => {
  const sup = new Supervisor(settings, webTools(), []);
  sup.onEvent(ev("t1", "turn.started", { trigger: "message" }));
  call(sup, "t1", "web.read", { url: "https://a.test/1" }, ["http_4xx", "page returned 403 (a.test)"]);
  assert.equal(notices(sup.checkpoint("t1", "before_model"))[0]?.level, 1);
  call(sup, "t1", "web.read", { url: "https://a.test/2" }, ["http_4xx", "page returned 403 (a.test)"]);
  const [n] = notices(sup.checkpoint("t1", "before_model"));
  assert.equal(n?.level, 2);
  assert.match(n!.text, /failure #2 on the same target/);

  const own = new Supervisor(settings, webTools(), []);
  own.onEvent(ev("t2", "turn.started", { trigger: "message" }));
  const kinds: string[] = [];
  for (const host of ["a", "b", "c"]) {
    call(own, "t2", "web.interact", { url: `https://${host}.test/`, actions: [] }, ["web_failed", "page.click: Timeout 8000ms exceeded."]);
    kinds.push(...own.checkpoint("t2", "before_model").map((a) => a.type));
  }
  assert.deepEqual(kinds, ["notice", "notice", "escalate"], "maxNoticesPerDetector still stops a tool that keeps failing");
});

test("a repeat is the same tool, code and target: other sites are not 'failure #2'", () => {
  const sup = new Supervisor(settings, webTools(), []);
  sup.onEvent(ev("t1", "turn.started", { trigger: "message" }));
  call(sup, "t1", "web.interact", { url: "https://a.test/", actions: [] }, ["web_failed", "no such selector"]);
  sup.checkpoint("t1", "before_model");
  call(sup, "t1", "web.interact", { url: "https://b.test/", actions: [] }, ["web_failed", "no such selector"]);
  const [other] = notices(sup.checkpoint("t1", "before_model"));
  assert.equal(other?.level, 1);
  assert.doesNotMatch(other!.text, /failure #/);
  const again = new Supervisor(settings, webTools(), []);
  again.onEvent(ev("t1", "turn.started", { trigger: "message" }));
  call(again, "t1", "web.interact", { url: "https://a.test/", actions: [] }, ["web_failed", "no such selector"]);
  again.checkpoint("t1", "before_model");
  call(again, "t1", "web.interact", { url: "https://a.test/cart", actions: [] }, ["web_failed", "no such selector"]);
  const [same] = notices(again.checkpoint("t1", "before_model"));
  assert.equal(same?.level, 2);
  assert.match(same!.text, /failure #2 of web\.interact with web_failed on the same target/);
});

test("tool docs: only the failing tool's section, once per tool per turn, cut to docsMaxChars", () => {
  withDocs((docs) => {
    const sup = new Supervisor(settings, webTools(docs), []);
    sup.onEvent(ev("t1", "turn.started", { trigger: "message" }));
    call(sup, "t1", "web.read", { url: "https://a.test/" }, ["net_blocked", "127.0.0.1 is a loopback address", "Only public http(s) pages. Private hosts are blocked."]);
    const [first] = notices(sup.checkpoint("t1", "before_model"));
    assert.match(first!.text, /Tool docs \(README\.md, section web\.read\):\n## web\.read\n\nREAD-DOCS/);
    assert.match(first!.text, /READ-ERRORS/, "subsections belong to the section");
    assert.doesNotMatch(first!.text, /SEARCH-DOCS|LINKS-DOCS|Intro text/);
    call(sup, "t1", "web.read", { url: "https://b.test/" }, ["net_blocked", "10.0.0.1 is a private address", "Only public http(s) pages. Private hosts are blocked."]);
    const [second] = notices(sup.checkpoint("t1", "before_model"));
    assert.doesNotMatch(second!.text, /Tool docs|READ-DOCS/, "the model already has them");
    call(sup, "t1", "web.search", { query: "" }, ["invalid_args", "query is empty"]);
    const [third] = notices(sup.checkpoint("t1", "before_model"));
    assert.match(third!.text, /section web\.search\):\n## web\.search\n\nSEARCH-DOCS/, "another tool gets its own section");

    const short = new Supervisor({ ...settings, docsMaxChars: 20 }, webTools(docs), []);
    short.onEvent(ev("t2", "turn.started", { trigger: "message" }));
    call(short, "t2", "web.interact", { url: "https://a.test/", actions: [] }, ["web_failed", "x"]);
    const [cut] = notices(short.checkpoint("t2", "before_model"));
    assert.match(cut!.text, /Tool docs \(README\.md\):\n# tool-web\n\nIntro te…/, "no section: the start of the file, cut");
  });
});

test("incidents: only a corrected call on the same target is a fix, and only matching incidents are quoted", () => {
  const sup = new Supervisor(settings, webTools(), []);
  sup.onEvent(ev("t1", "turn.started", { trigger: "message" }));
  call(sup, "t1", "web.interact", { url: "https://shop.test/", actions: [{ type: "click", selector: "#buy" }] }, ["web_failed", "page.click: Timeout 8000ms exceeded. waiting for locator('#buy')"]);
  sup.checkpoint("t1", "before_model");
  call(sup, "t1", "web.interact", { url: "https://other.test/", actions: [] });
  assert.deepEqual(sup.onEvent(ev("t1", "turn.completed", { steps: 2 })), [], "another site is not a fix");

  sup.onEvent(ev("t2", "turn.started", { trigger: "message" }));
  call(sup, "t2", "web.interact", { url: "https://shop.test/", actions: [{ type: "click", selector: "#buy" }] }, ["web_failed", "page.click: Timeout 8000ms exceeded. waiting for locator('#buy')"]);
  sup.checkpoint("t2", "before_model");
  call(sup, "t2", "web.interact", { url: "https://shop.test/item", actions: [{ type: "click", selector: "button.buy" }] });
  const [inc] = sup.onEvent(ev("t2", "turn.completed", { steps: 2 }));
  assert.ok(inc);
  assert.match(inc.fixSummary, /button\.buy.*"url":"https:\/\/shop\.test\/item"/);
  sup.addIncident({ ...inc, id: "inc_shop", createdAt: "" });
  sup.addIncident({ id: "inc_other_msg", tool: "web.interact", code: "web_failed", message: "playwright is not installed", fixSummary: "after web_failed the call worked", createdAt: "" });
  sup.addIncident({ ...inc, id: "inc_other_host", fixSummary: 'after web_failed the call worked with arguments {"url":"https://elsewhere.test/"}', createdAt: "" });

  sup.onEvent(ev("t3", "turn.started", { trigger: "message" }));
  call(sup, "t3", "web.interact", { url: "https://shop.test/", actions: [{ type: "click", selector: "#buy" }] }, ["web_failed", "page.click: Timeout 8000ms exceeded. waiting for locator('#buy')"]);
  const [n] = notices(sup.checkpoint("t3", "before_model"));
  assert.deepEqual(n!.refs?.filter((r) => r.startsWith("incident:")), ["incident:inc_shop"], "same message and same site only");
});

test("helpers: targets, corrections, message keys and doc sections", () => {
  assert.equal(targetOf({ url: "https://Market.Yandex.ru/x?y=1" }), "host:market.yandex.ru");
  assert.equal(targetOf({ path: "a.txt", text: "x" }), "path:a.txt");
  assert.equal(targetOf({}), undefined);
  assert.equal(targetOf("x"), undefined);
  assert.ok(isCorrection({}, { text: "hi" }), "a call that named nothing is fixed by any call");
  assert.ok(isCorrection({ url: "https://a.test/1" }, { url: "https://a.test/2" }));
  assert.ok(!isCorrection({ url: "https://a.test/1" }, { url: "https://b.test/1" }));
  assert.equal(messageKey("Page returned 429 at https://privetpeople.ru/publ/x?id=123456"), "page returned 429 at privetpeople.ru");
  assert.notEqual(messageKey("page returned 404"), messageKey("page returned 401"));
  assert.equal(docsSection(README, "web.links"), "## web.links\n\nLINKS-DOCS.");
  assert.equal(docsSection(README, "web.screenshot"), undefined);
  assert.equal(docsSection("## `web.read {url}`\nX\n## y", "web.read"), "## `web.read {url}`\nX");
  assert.equal(docsSection("## web.reader\nX", "web.read"), undefined);
});
