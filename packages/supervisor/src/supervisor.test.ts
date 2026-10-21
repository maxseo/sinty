import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventDataMap, EventType, SintyEvent } from "@sinty/sdk";
import type { SupervisorSettings } from "./protocol.js";
import { Supervisor } from "./supervisor.js";

const settings: SupervisorSettings = { loopThreshold: 3, maxNoticesPerTurn: 6, maxNoticesPerDetector: 2, docsMaxChars: 500, budget: { steps: 10, tokens: 1000 } };
const tools = [{ name: "web.get", plugin: "tool-web", sideEffects: "read" as const, editable: true }];

let seq = 0;
function ev<T extends EventType>(turnId: string, type: T, data: EventDataMap[T]): SintyEvent {
  return { id: `e${++seq}`, seq, ts: new Date().toISOString(), sessionId: "ses_1", turnId, type, actor: { kind: "system", id: "core" }, data } as SintyEvent;
}

function step(sup: Supervisor, turnId: string, callId: string, args: unknown, fail?: string): void {
  sup.onEvent(ev(turnId, "model.response", { toolCalls: [{ callId, tool: "web.get", args }], stopReason: "tool_use", usage: { provider: "p", model: "m", inputTokens: 10, outputTokens: 5 } }));
  sup.onEvent(ev(turnId, "tool.call.requested", { callId, tool: "web.get", args }));
  if (fail) sup.onEvent(ev(turnId, "tool.call.failed", { callId, code: fail, message: "boom", durationMs: 1 }));
  else sup.onEvent(ev(turnId, "tool.call.completed", { callId, result: "ok", durationMs: 1 }));
}

test("a loop of identical successful calls gets a notice, then escalates", () => {
  const sup = new Supervisor(settings, tools, []);
  sup.onEvent(ev("t1", "turn.started", { trigger: "message" }));
  for (let i = 0; i < 3; i++) step(sup, "t1", `c${i}`, { url: "a" });
  const [n] = sup.checkpoint("t1", "before_model");
  assert.equal(n?.type, "notice");
  assert.equal(n?.type === "notice" && n.detector, "loop");
  for (let i = 3; i < 5; i++) step(sup, "t1", `c${i}`, { url: "a" });
  assert.deepEqual(sup.checkpoint("t1", "before_model").map((a) => a.type), ["escalate"]);
  assert.deepEqual(sup.checkpoint("t1", "before_model"), [], "nothing more after escalation");
});

test("a tool failing in three turns suggests a plugin patch; corrected calls become incidents", () => {
  const sup = new Supervisor(settings, tools, []);
  for (const t of ["t1", "t2"]) {
    sup.onEvent(ev(t, "turn.started", { trigger: "message" }));
    step(sup, t, `${t}a`, { url: "https://a.test/x" }, "bug");
    sup.checkpoint(t, "before_model");
    step(sup, t, `${t}b`, { url: "https://a.test/y" });
    const incidents = sup.onEvent(ev(t, "turn.completed", { steps: 2 }));
    if (t === "t1") assert.equal(incidents[0]?.tool, "web.get");
    if (incidents[0]) sup.addIncident({ ...incidents[0], id: `inc_${t}`, createdAt: "" });
  }
  sup.onEvent(ev("t3", "turn.started", { trigger: "message" }));
  step(sup, "t3", "t3a", { url: "https://a.test/z" }, "bug");
  const [n] = sup.checkpoint("t3", "before_model");
  assert.ok(n?.type === "notice");
  assert.equal(n.level, 3);
  assert.match(n.text, /plugin tool-web .*plugin\.propose_patch/);
  assert.match(n.text, /A similar incident was solved before/);
  assert.ok(n.refs?.includes("incident:inc_t1"));
});

test("budget warning at 80% and truncated output notice", () => {
  const sup = new Supervisor(settings, tools, []);
  sup.onEvent(ev("t1", "turn.started", { trigger: "message" }));
  for (let i = 0; i < 8; i++) step(sup, "t1", `c${i}`, { url: String(i) });
  assert.deepEqual(sup.checkpoint("t1", "before_model").map((a) => a.type === "notice" && a.detector), ["budget"]);
  sup.onEvent(ev("t1", "model.response", { text: "partial", toolCalls: [], stopReason: "length", usage: { provider: "p", model: "m", inputTokens: 1, outputTokens: 1 } }));
  const [n] = sup.checkpoint("t1", "before_complete");
  assert.ok(n?.type === "notice" && /cut off/.test(n.text));
  assert.deepEqual(sup.checkpoint("t1", "before_complete"), [], "the same response is checked once");
});

test("a human message resets counters after escalation", () => {
  const sup = new Supervisor({ ...settings, maxNoticesPerDetector: 1 }, tools, []);
  sup.onEvent(ev("t1", "turn.started", { trigger: "message" }));
  step(sup, "t1", "a", { url: "1" }, "bug");
  assert.equal(sup.checkpoint("t1", "before_model")[0]?.type, "notice");
  step(sup, "t1", "b", { url: "2" }, "bug");
  assert.equal(sup.checkpoint("t1", "before_model")[0]?.type, "escalate");
  sup.onEvent(ev("t1", "message.user", { text: "try again" }));
  step(sup, "t1", "c", { url: "3" }, "bug");
  assert.equal(sup.checkpoint("t1", "before_model")[0]?.type, "notice");
});
