import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventDataMap, EventType, SintyEvent, Usage } from "@sinty/sdk";
import { budgetTokens, resolveSettings, type SupervisorSettings } from "./protocol.js";
import { HIDDEN, maskArgs, scrubText } from "./scrub.js";
import { Supervisor } from "./supervisor.js";

const base: SupervisorSettings = { loopThreshold: 3, maxNoticesPerTurn: 6, maxNoticesPerDetector: 2, docsMaxChars: 500, budget: { steps: 100, tokens: 1000 } };
const tools = [{ name: "web.interact", plugin: "core", sideEffects: "external" as const, editable: false }];

let seq = 0;
function ev<T extends EventType>(turnId: string, type: T, data: EventDataMap[T]): SintyEvent {
  return { id: `e${++seq}`, seq, ts: new Date().toISOString(), sessionId: "ses_1", turnId, type, actor: { kind: "system", id: "core" }, data } as SintyEvent;
}
const usage = (inputTokens: number, outputTokens: number, cachedTokens = 0): Usage => ({ provider: "p", model: "m", inputTokens, outputTokens, ...(cachedTokens ? { cachedTokens } : {}) });

function call(sup: Supervisor, turnId: string, callId: string, args: unknown, u: Usage, fail?: string): void {
  sup.onEvent(ev(turnId, "model.response", { toolCalls: [{ callId, tool: "web.interact", args }], stopReason: "tool_use", usage: u }));
  sup.onEvent(ev(turnId, "tool.call.requested", { callId, tool: "web.interact", args }));
  if (fail) sup.onEvent(ev(turnId, "tool.call.failed", { callId, code: fail, message: "element not found", durationMs: 1 }));
  else sup.onEvent(ev(turnId, "tool.call.completed", { callId, result: "ok", durationMs: 1 }));
}

test("defaults: weighted budget, 80% warning, every check on", () => {
  const r = resolveSettings(base);
  assert.equal(r.budget.count, "weighted");
  assert.equal(r.budget.warnAt, 0.8);
  assert.equal(r.loopBlockAfter, 5);
  assert.deepEqual(r.checks, { toolErrors: true, loop: true, budget: true, badOutput: true });
});

test("budgetTokens: cached prompt tokens count at their weight", () => {
  const u = usage(100_000, 2_000, 90_000);
  assert.equal(budgetTokens(u, "all", 0.1), 102_000);
  assert.equal(budgetTokens(u, "uncached", 0.1), 12_000);
  assert.equal(budgetTokens(u, "weighted", 0.1), 21_000);
});

test("a weighted budget does not warn on a mostly cached turn; the raw count does", () => {
  for (const [count, warns] of [["weighted", false], ["all", true]] as const) {
    const sup = new Supervisor({ ...base, budget: { tokens: 1000, count } }, tools, []);
    sup.onEvent(ev("t1", "turn.started", { trigger: "message" }));
    for (let i = 0; i < 3; i++) call(sup, "t1", `c${i}`, { action: "click", selector: `#b${i}` }, usage(300, 10, 290));
    const kinds = sup.checkpoint("t1", "before_model").map((a) => a.type === "notice" && a.detector);
    assert.equal(kinds.includes("budget"), warns, count);
  }
});

test("checks can be switched off and escalation disabled", () => {
  const sup = new Supervisor({ ...base, checks: { loop: false } }, tools, []);
  sup.onEvent(ev("t1", "turn.started", { trigger: "message" }));
  for (let i = 0; i < 6; i++) call(sup, "t1", `c${i}`, { action: "click", selector: "#same" }, usage(10, 1));
  assert.deepEqual(sup.checkpoint("t1", "before_model"), [], "loop check off");

  const quiet = new Supervisor({ ...base, maxNoticesPerDetector: 1, escalate: false }, tools, []);
  quiet.onEvent(ev("t1", "turn.started", { trigger: "message" }));
  call(quiet, "t1", "a", { action: "click", selector: "#1" }, usage(10, 1), "bug");
  assert.equal(quiet.checkpoint("t1", "before_model")[0]?.type, "notice");
  call(quiet, "t1", "b", { action: "click", selector: "#2" }, usage(10, 1), "bug");
  assert.deepEqual(quiet.checkpoint("t1", "before_model"), [], "no escalation, the extra notice is dropped");
});

test("settings change live through setSettings", () => {
  const sup = new Supervisor(base, tools, []);
  sup.setSettings({ ...base, checks: { toolErrors: false } });
  sup.onEvent(ev("t1", "turn.started", { trigger: "message" }));
  call(sup, "t1", "a", { action: "click", selector: "#1" }, usage(10, 1), "bug");
  assert.deepEqual(sup.checkpoint("t1", "before_model"), []);
});

test("text typed into a page and secret fields never reach an incident", () => {
  const typed = "Correct-Horse-41";
  const sup = new Supervisor(base, tools, []);
  sup.onEvent(ev("t1", "turn.started", { trigger: "message" }));
  call(sup, "t1", "a", { action: "type", selector: "#pw", text: typed }, usage(10, 1), "not_found");
  sup.checkpoint("t1", "before_model");
  call(sup, "t1", "b", { action: "type", selector: "input[name=password]", text: typed, password: typed, file: "x".repeat(5000) }, usage(10, 1));
  const [inc] = sup.onEvent(ev("t1", "turn.completed", { steps: 2 }));
  assert.ok(inc, "the fix became an incident");
  const stored = JSON.stringify(inc);
  assert.ok(!stored.includes(typed), stored);
  assert.ok(stored.includes(HIDDEN));
  assert.ok(stored.length < 1500, `long values are cut: ${stored.length}`);
});

test("maskArgs and scrubText hide secrets and cut long values; scrubbing is idempotent", () => {
  const m = maskArgs({ action: "fill", selector: "#u", value: "pw-123456", apiKey: "k", nested: { token: "t", note: "y".repeat(300) } }) as Record<string, unknown>;
  assert.equal(m.value, HIDDEN);
  assert.equal(m.apiKey, HIDDEN);
  assert.equal((m.nested as Record<string, unknown>).token, HIDDEN);
  assert.match(String((m.nested as Record<string, unknown>).note), /…\[300 chars\]$/);
  assert.equal(m.selector, "#u");

  const old = `Fixed with {"action":"type","selector":"#pw","text":"Old-Secret-99"} and {"password":"P4ss-xyz"} at https://x.test/?token=abc123 using sk-abcdefghijklmnopqrstuv and {"content":"${"z".repeat(4000)}"}`;
  const once = scrubText(old);
  for (const secret of ["Old-Secret-99", "P4ss-xyz", "abc123", "sk-abcdefghijklmnopqrstuv"]) assert.ok(!once.includes(secret), `${secret} in ${once}`);
  assert.ok(once.length < 600, `long JSON values are cut: ${once.length}`);
  assert.equal(scrubText(once), once);
  assert.equal(scrubText("plain words stay"), "plain words stay");
});
