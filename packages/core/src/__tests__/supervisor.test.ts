import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { SintyEvent } from "@sinty/sdk";
import { policySchema } from "../config.js";
import { boot, tempHome, types } from "./helpers.js";

const allowAll = policySchema.parse({ defaults: { none: "allow", read: "allow", write: "allow", external: "allow" } });
const PLUGINS = ["fake-provider", "test-tools", "flaky"];

function notices(events: SintyEvent[]): { detector: string; level: number; text: string }[] {
  return events.filter((e) => e.type === "supervisor.notice").map((e) => e.data as { detector: string; level: number; text: string });
}

test("supervisor: a failed tool gets a notice with the hint and the plugin docs before the next model step", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ toolCalls: [{ name: "flaky__get", args: {} }] }, { echoLastTool: true }], { policy: allowAll, plugins: PLUGINS });
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "get it");
    await sinty.agent.idle();
    const events = sinty.journal.events(s.id);
    const t = types(events);
    assert.ok(t.indexOf("supervisor.notice") > t.indexOf("tool.call.failed"));
    assert.ok(t.indexOf("supervisor.notice") < t.lastIndexOf("model.request"));
    const [n] = notices(events);
    assert.equal(n?.detector, "tool_error");
    assert.match(n!.text, /flaky\.get failed \(bug: flaky\.get is broken\)/);
    assert.match(n!.text, /the plugin has a bug/);
    assert.match(n!.text, /returns `42`/);
    assert.equal(sinty.journal.activeTurn(s.id), undefined);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("supervisor: repeated failures escalate to a human; a human message resumes the turn", async () => {
  const { home, cleanup } = tempHome();
  const call = { toolCalls: [{ name: "flaky__get", args: {} }] };
  const sinty = await boot(home, [call, call, call, { text: "I stopped, the tool is broken" }], { policy: allowAll, plugins: PLUGINS });
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "get it");
    await sinty.agent.idle();
    const turn = sinty.journal.activeTurn(s.id);
    assert.equal(turn?.status, "blocked");
    const events = sinty.journal.events(s.id);
    const blocked = events.findLast((e) => e.type === "turn.blocked")!.data as { reason: string };
    assert.equal(blocked.reason, "supervisor");
    assert.ok(types(events).includes("supervisor.escalated"));
    assert.equal(Math.max(...notices(events).map((n) => n.level)), 2);

    const { turnId } = sinty.agent.send(s.id, "stop calling it and tell me what happened");
    assert.equal(turnId, turn!.id);
    await sinty.agent.idle();
    const after = sinty.journal.events(s.id);
    assert.equal(sinty.journal.getTurn(turnId)?.status, "completed");
    assert.equal((after.findLast((e) => e.type === "message.agent")!.data as { text: string }).text, "I stopped, the tool is broken");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("supervisor: an empty final answer is sent back to the model once", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{}, { text: "the real answer" }], { policy: allowAll, plugins: PLUGINS });
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "hello");
    await sinty.agent.idle();
    const events = sinty.journal.events(s.id);
    assert.deepEqual(
      notices(events).map((n) => n.detector),
      ["bad_output"],
    );
    const agentMessages = events.filter((e) => e.type === "message.agent").map((e) => (e.data as { text: string }).text);
    assert.deepEqual(agentMessages, ["the real answer"]);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("supervisor: a fixed failure becomes an incident that is offered in later sessions", async () => {
  const { home, cleanup } = tempHome();
  const script = [{ toolCalls: [{ name: "echo__say", args: {} }] }, { toolCalls: [{ name: "echo__say", args: { text: "hi" } }] }, { text: "done" }];
  const sinty = await boot(home, script, { policy: allowAll, plugins: PLUGINS });
  try {
    const s1 = sinty.agent.createSession();
    sinty.agent.send(s1.id, "say hi");
    await sinty.agent.idle();
    for (let i = 0; i < 50 && !sinty.journal.incidents().length; i++) await sleep(20);
    const [incident] = sinty.journal.incidents();
    assert.equal(incident?.tool, "echo.say");
    assert.equal(incident?.code, "invalid_args");
    assert.ok(types(sinty.journal.events(s1.id)).includes("supervisor.incident_resolved"));

    const s2 = sinty.agent.createSession();
    sinty.agent.send(s2.id, "say hi again");
    await sinty.agent.idle();
    const [n] = notices(sinty.journal.events(s2.id));
    assert.equal(n?.detector, "invalid_args");
    assert.match(n!.text, /A similar incident was solved before: .*"text":"hi"/);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("budget: an exhausted turn blocks instead of failing and continues after a human message", async () => {
  const { home, cleanup } = tempHome();
  const call = { toolCalls: [{ name: "echo__say", args: { text: "x" } }] };
  const sinty = await boot(home, [call, call, { text: "finished" }], {
    policy: policySchema.parse({ defaults: { none: "allow", read: "allow", write: "allow", external: "allow" }, budgets: { turn: { steps: 2 } } }),
    plugins: PLUGINS,
  });
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "go");
    await sinty.agent.idle();
    const blocked = sinty.journal.events(s.id).findLast((e) => e.type === "turn.blocked")?.data as { reason: string } | undefined;
    assert.equal(blocked?.reason, "budget");
    sinty.agent.send(s.id, "continue");
    await sinty.agent.idle();
    const last = sinty.journal.events(s.id).findLast((e) => e.type === "message.agent")?.data as { text: string } | undefined;
    assert.equal(last?.text, "finished");
  } finally {
    await sinty.stop();
    cleanup();
  }
});
