import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { SintyEvent } from "@sinty/sdk";
import { policySchema } from "../config.js";
import { boot, find, tempHome, types } from "./helpers.js";

const allowAll = policySchema.parse({ defaults: { none: "allow", read: "allow", write: "allow", external: "allow" } });

async function runTurn(sinty: Awaited<ReturnType<typeof boot>>, text: string): Promise<{ sessionId: string; events: SintyEvent[] }> {
  const s = sinty.agent.createSession();
  sinty.agent.send(s.id, text);
  await sinty.agent.idle();
  return { sessionId: s.id, events: sinty.journal.events(s.id) };
}

test("turn: model calls a tool, gets the result, answers", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ toolCalls: [{ name: "echo__say", args: { text: "hi" } }] }, { text: "all done" }], { policy: allowAll });
  try {
    const { events } = await runTurn(sinty, "say hi");
    assert.deepEqual(types(events), [
      "session.created",
      "turn.started",
      "message.user",
      "model.request",
      "model.response",
      "tool.call.requested",
      "tool.call.started",
      "tool.call.completed",
      "model.request",
      "model.response",
      "message.agent",
      "turn.completed",
    ]);
    assert.equal(find<{ result: unknown }>(events, "tool.call.completed")?.result, "hi");
    assert.equal(find<{ text: string }>(events, "message.agent")?.text, "all done");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("policy ask blocks the turn until approved", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ toolCalls: [{ name: "side__effect", args: { line: "written" } }] }, { text: "ok" }]);
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "write");
    await sinty.agent.idle();
    assert.equal(sinty.journal.activeTurn(s.id)?.status, "blocked");
    const req = find<{ callId: string }>(sinty.journal.events(s.id), "tool.call.approval_requested")!;
    assert.throws(() => sinty.agent.send(s.id, "hurry"), /blocked/);

    sinty.agent.decide(s.id, req.callId, "approve", { kind: "human", id: "test" });
    await sinty.agent.idle();
    const events = sinty.journal.events(s.id);
    assert.ok(types(events).includes("turn.completed"));
    assert.equal(readFileSync(join(home, "workspace", "effects.log"), "utf8"), "written\n");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("denied call is reported to the model and the turn continues", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ toolCalls: [{ name: "side__effect", args: { line: "x" } }] }, { echoLastTool: true }], {
    policy: policySchema.parse({ tools: { "side.*": "deny" } }),
  });
  try {
    const { events } = await runTurn(sinty, "write");
    assert.ok(types(events).includes("tool.call.denied"));
    assert.match(find<{ text: string }>(events, "message.agent")!.text, /DENIED: denied by policy tools\["side\.\*"\]/);
    assert.ok(!existsSync(join(home, "workspace", "effects.log")));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("invalid arguments fail before the tool runs, with a hint", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ toolCalls: [{ name: "echo__say", args: { text: 42 } }] }, { echoLastTool: true }], { policy: allowAll });
  try {
    const { events } = await runTurn(sinty, "x");
    const failed = find<{ code: string; hint: string }>(events, "tool.call.failed")!;
    assert.equal(failed.code, "invalid_args");
    assert.match(find<{ text: string }>(events, "message.agent")!.text, /ERROR invalid_args/);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("ask_human blocks; the next message is the answer", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ toolCalls: [{ name: "ask_human", args: { question: "which color?" } }] }, { echoLastTool: true }], { policy: allowAll });
  try {
    const s = sinty.agent.createSession();
    const { turnId } = sinty.agent.send(s.id, "paint");
    await sinty.agent.idle();
    assert.equal(find<{ detail: string }>(sinty.journal.events(s.id), "turn.blocked")?.detail, "which color?");
    assert.equal(sinty.agent.send(s.id, "blue").turnId, turnId);
    await sinty.agent.idle();
    const events = sinty.journal.events(s.id);
    assert.match(find<{ text: string }>(events, "message.agent")!.text, /"answer":"blue"/);
    assert.equal(sinty.journal.getTurn(turnId)?.status, "completed");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("a crashing plugin fails only the call; the plugin restarts", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(
    home,
    [{ toolCalls: [{ name: "crash__now", args: {} }] }, { toolCalls: [{ name: "echo__say", args: { text: "back" } }] }, { echoLastTool: true }],
    { policy: allowAll },
  );
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "crash");
    await sinty.agent.idle();
    const events = sinty.journal.events(s.id);
    assert.equal(find<{ code: string }>(events, "tool.call.failed")?.code, "plugin_crashed");
    assert.equal(find<{ result: unknown }>(events, "tool.call.completed")?.result, "back", "the call after the crash waits for the restarted plugin");
    assert.ok(types(events).includes("turn.completed"));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("interrupt stops a running tool and ends the turn", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ toolCalls: [{ name: "sleep__long", args: { ms: 30_000 } }] }], { policy: allowAll });
  try {
    const s = sinty.agent.createSession();
    const { turnId } = sinty.agent.send(s.id, "sleep");
    await sleep(300);
    assert.ok(await sinty.agent.interrupt(s.id));
    assert.equal(sinty.journal.getTurn(turnId)?.status, "interrupted");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("provider outage falls back to the next model", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ text: "from fallback" }], {
    policy: allowAll,
    config: {
      providers: { bad: { protocol: "fake", options: { fail: true } }, fake: { protocol: "fake", options: { script: [{ text: "from fallback" }] } } },
      models: { default: "bad/x", fallback: ["fake/y"], routes: {}, maxOutputTokens: 100 },
    },
  });
  try {
    const { events } = await runTurn(sinty, "hi");
    assert.match(find<{ reason: string }>(events, "model.fallback")!.reason, /http_503/);
    assert.equal(find<{ text: string }>(events, "message.agent")?.text, "from fallback");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("resume after a core crash: idempotent call reruns, non-idempotent is reported as interrupted", async () => {
  const { home, cleanup } = tempHome();
  const script = [
    {
      toolCalls: [
        { name: "echo__say", args: { text: "again" } },
        { name: "side__effect", args: { line: "maybe" } },
      ],
    },
    { echoLastTool: true },
  ];
  let sinty = await boot(home, script, { policy: allowAll });
  const s = sinty.agent.createSession();
  const turnId = "trn_crashed";
  const j = sinty.journal;
  const sys = { kind: "system", id: "test" } as const;
  j.startTurn(turnId, s.id);
  j.append({ sessionId: s.id, turnId, type: "turn.started", actor: sys, data: { trigger: "message" } });
  j.append({ sessionId: s.id, turnId, type: "message.user", actor: { kind: "human", id: "t" }, data: { text: "go" } });
  const toolCalls = [
    { callId: "c1", tool: "echo.say", args: { text: "again" } },
    { callId: "c2", tool: "side.effect", args: { line: "maybe" } },
  ];
  j.append({ sessionId: s.id, turnId, stepId: "stp_1", type: "model.response", actor: sys, data: { toolCalls, stopReason: "tool_use", usage: { provider: "fake", model: "m", inputTokens: 1, outputTokens: 1 } } });
  j.append({ sessionId: s.id, turnId, stepId: "stp_1", type: "tool.call.started", actor: sys, data: { callId: "c1", tool: "echo.say", idempotencyKey: "k1" } });
  await sinty.stop();

  sinty = await boot(home, script, { policy: allowAll });
  try {
    await sinty.agent.idle();
    assert.equal(sinty.journal.turnEvents(turnId).filter((e) => e.type === "turn.resumed").length, 1);
    const events = sinty.journal.turnEvents(turnId);
    const results = events.filter((e) => e.type === "tool.call.completed" || e.type === "tool.call.failed").map((e) => [(e.data as { callId: string }).callId, e.type]);
    assert.deepEqual(results, [
      ["c1", "tool.call.completed"],
      ["c2", "tool.call.completed"],
    ]);
    assert.equal(sinty.journal.getTurn(turnId)?.status, "completed");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("non-idempotent call started before a crash is not repeated", async () => {
  const { home, cleanup } = tempHome();
  const script = [{ toolCalls: [{ name: "side__effect", args: { line: "once" } }] }, { echoLastTool: true }];
  let sinty = await boot(home, script, { policy: allowAll });
  const s = sinty.agent.createSession();
  const turnId = "trn_crashed2";
  const j = sinty.journal;
  const sys = { kind: "system", id: "test" } as const;
  j.startTurn(turnId, s.id);
  j.append({ sessionId: s.id, turnId, type: "turn.started", actor: sys, data: { trigger: "message" } });
  j.append({ sessionId: s.id, turnId, type: "message.user", actor: { kind: "human", id: "t" }, data: { text: "go" } });
  j.append({ sessionId: s.id, turnId, stepId: "stp_1", type: "model.response", actor: sys, data: { toolCalls: [{ callId: "c1", tool: "side.effect", args: { line: "once" } }], stopReason: "tool_use", usage: { provider: "fake", model: "m", inputTokens: 1, outputTokens: 1 } } });
  j.append({ sessionId: s.id, turnId, stepId: "stp_1", type: "tool.call.started", actor: sys, data: { callId: "c1", tool: "side.effect", idempotencyKey: "k1" } });
  await sinty.stop();

  sinty = await boot(home, script, { policy: allowAll });
  try {
    await sinty.agent.idle();
    const events = sinty.journal.turnEvents(turnId);
    assert.equal(find<{ code: string }>(events, "tool.call.failed")?.code, "interrupted");
    assert.ok(!existsSync(join(home, "workspace", "effects.log")), "side effect must not run twice");
    assert.match(find<{ text: string }>(events, "message.agent")!.text, /ERROR interrupted/);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("sandbox: a plugin cannot write config, read secrets, write the core, spawn or reach the network", async () => {
  const { home, cleanup } = tempHome();
  const { resolvePaths } = await import("../paths.js");
  const paths = resolvePaths(home);
  const args = { config: paths.config, secrets: paths.secrets, core: join(paths.install, "packages", "core", "dist", "pwned.js") };
  const sinty = await boot(home, [{ toolCalls: [{ name: "evil__escape", args }] }, { text: "done" }], { policy: allowAll, plugins: ["fake-provider", "evil", "greedy"] });
  try {
    assert.ok(!sinty.host.plugins.has("greedy"), "greedy plugin must be refused");
    const { events } = await runTurn(sinty, "escape");
    const r = find<{ result: Record<string, string> }>(events, "tool.call.completed")!.result;
    for (const [k, v] of Object.entries(r)) assert.notEqual(v, "ESCAPED", `${k} escaped`);
    assert.equal(r.writeConfig, "ERR_ACCESS_DENIED");
    assert.equal(r.readSecrets, "ERR_ACCESS_DENIED");
    assert.equal(r.writeCore, "ERR_ACCESS_DENIED");
    assert.equal(r.fetchDenied, "net_denied");
    assert.ok(!readFileSync(paths.config, "utf8").includes("pwned"));
  } finally {
    await sinty.stop();
    cleanup();
  }
});
