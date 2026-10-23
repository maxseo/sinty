import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { configSchema, policySchema, type SintyConfig } from "../config.js";
import { boot, tempHome } from "./helpers.js";

const allowAll = policySchema.parse({ defaults: { none: "allow", read: "allow", write: "allow", external: "allow" } });
const noStall: Partial<SintyConfig> = {
  supervisor: configSchema.parse({ supervisor: { stallSeconds: 0, stallBlock: false, budget: { stop: false } } }).supervisor,
};

async function waitFor<T>(fn: () => T | undefined, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v as T;
    await sleep(20);
  }
  throw new Error("timeout");
}

test("interrupt cancels a blocking agent.task child", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], {
    policy: allowAll,
    plugins: ["recording-provider", "test-tools"],
    config: {
      ...noStall,
      providers: {
        rec: {
          protocol: "rec",
          options: {
            script: {
              go: [{ toolCalls: [{ name: "agent__task", args: { task: "dig", tools: ["sleep.long"] } }] }, { text: "parent done" }],
              dig: [{ toolCalls: [{ name: "sleep__long", args: { ms: 30_000 } }] }, { text: "woke" }],
            },
          },
        },
      },
      models: { default: "rec/test-model", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
    },
  });
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "go");
    const childId = await waitFor(() => sinty.journal.listSessions(50).find((x) => x.metadata?.parentSessionId === s.id)?.id);
    await waitFor(() => sinty.journal.events(childId).find((e) => e.type === "tool.call.started" && (e.data as { tool: string }).tool === "sleep.long"));
    assert.equal(await sinty.agent.interrupt(s.id), true);
    await sinty.agent.idle();
    const childEvents = sinty.journal.events(childId);
    assert.ok(
      childEvents.some((e) => e.type === "turn.interrupted"),
      `child should be interrupted, got: ${childEvents.map((e) => e.type).join(",")}`,
    );
    assert.ok(!sinty.journal.activeTurn(s.id));
    assert.ok(!sinty.journal.activeTurn(childId));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("background agent.task returns taskId and notifies parent with task.completed", async () => {
  const { home, cleanup } = tempHome();
  // recording-provider keys steps by last user text so parent and child sessions do not share a fake script index.
  const sinty = await boot(home, [], {
    policy: allowAll,
    plugins: ["recording-provider", "test-tools"],
    config: {
      ...noStall,
      providers: {
        rec: {
          protocol: "rec",
          options: {
            script: {
              "please research": [
                { toolCalls: [{ name: "agent__task", args: { task: "research X", background: true, tools: ["echo__say"] } }] },
                { text: "ack, working in background" },
              ],
              "research X": [
                { toolCalls: [{ name: "echo__say", args: { text: "found-it" } }] },
                { text: "child done: found-it" },
              ],
            },
          },
        },
      },
      models: { default: "rec/test-model", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
    },
  });
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "please research");
    await waitFor(() => sinty.journal.events(s.id).find((e) => e.type === "task.completed"));
    await sinty.agent.idle();
    const events = sinty.journal.events(s.id);
    const bg = events.find((e) => e.type === "tool.call.completed" && (e.data as { result?: { taskId?: string } }).result?.taskId);
    assert.ok(bg);
    const taskId = (bg!.data as { result: { taskId: string } }).result.taskId;
    assert.match(taskId, /^tsk_/);
    const done = events.find((e) => e.type === "task.completed")!;
    assert.equal((done.data as { taskId: string }).taskId, taskId);
    assert.equal((done.data as { status: string }).status, "completed");
    assert.match((done.data as { text: string }).text, /found-it/i);
    assert.ok(events.some((e) => e.type === "turn.started" && (e.data as { trigger: string }).trigger === "task"));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("agent.task_steer appends into a child of this session", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(
    home,
    [
      { toolCalls: [{ name: "agent__task_steer", args: { taskId: "tsk_test", text: "only official docs" } }] },
      { text: "steered" },
    ],
    { policy: allowAll, config: noStall },
  );
  try {
    const parent = sinty.agent.createSession();
    const child = sinty.agent.createSession({
      title: "child",
      metadata: { parentSessionId: parent.id, taskId: "tsk_test", background: true, tools: ["echo__say"] },
    });
    const before = sinty.journal.events(child.id).filter((e) => e.type === "message.user").length;
    sinty.agent.send(parent.id, "steer the child");
    await sinty.agent.idle();
    const users = sinty.journal.events(child.id).filter((e) => e.type === "message.user").map((e) => (e.data as { text: string }).text);
    assert.equal(users.length, before + 1);
    assert.equal(users.at(-1), "only official docs");
    const steer = sinty.journal.events(parent.id).find((e) => e.type === "tool.call.completed");
    assert.ok(steer);
    assert.equal((steer!.data as { result: { sessionId: string } }).result.sessionId, child.id);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("stopAll interrupts parent and background children", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(
    home,
    [
      { toolCalls: [{ name: "agent__task", args: { task: "bg", background: true, tools: ["sleep.long"] } }] },
      { toolCalls: [{ name: "sleep__long", args: { ms: 8000 } }] },
      { text: "never" },
    ],
    { policy: allowAll, config: noStall },
  );
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "go");
    const childId = await waitFor(() => sinty.journal.listSessions(50).find((x) => x.metadata?.parentSessionId === s.id && sinty.journal.activeTurn(x.id))?.id);
    assert.equal(await sinty.agent.stopAll(s.id), true);
    await sinty.agent.idle();
    assert.ok(!sinty.journal.activeTurn(s.id));
    assert.ok(!sinty.journal.activeTurn(childId));
    const events = sinty.journal.events(s.id);
    assert.ok(events.some((e) => e.type === "task.completed" && (e.data as { status: string }).status === "interrupted"));
    assert.ok(
      !events.some((e) => e.type === "turn.started" && (e.data as { trigger?: string }).trigger === "task"),
      "stop-all must not wake the parent with trigger=task",
    );
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("background agent.task child inherits parent projectId", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(
    home,
    [
      { toolCalls: [{ name: "agent__task", args: { task: "bg", background: true, tools: ["echo__say"] } }] },
      { text: "ack" },
    ],
    { policy: allowAll, config: noStall },
  );
  try {
    const s = sinty.agent.createSession({ projectId: "prj_test_inherit" });
    sinty.agent.send(s.id, "go");
    const child = await waitFor(() => sinty.journal.listSessions(50).find((x) => x.metadata?.parentSessionId === s.id));
    assert.equal(child.projectId, "prj_test_inherit");
    await sinty.agent.idle();
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("background children respect taskMaxParallel", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(
    home,
    [
      {
        toolCalls: [
          { name: "agent__task", args: { task: "a", background: true, tools: ["sleep.long"] } },
          { name: "agent__task", args: { task: "b", background: true, tools: ["sleep.long"] } },
          { name: "agent__task", args: { task: "c", background: true, tools: ["sleep.long"] } },
        ],
      },
      { text: "launched what I could" },
    ],
    { policy: allowAll, config: { ...noStall, agent: configSchema.parse({ agent: { taskMaxParallel: 2 } }).agent } },
  );
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "parallel");
    await sinty.agent.idle();
    const completed = sinty.journal.events(s.id).filter((e) => e.type === "tool.call.completed" || e.type === "tool.call.failed");
    const ok = completed.filter((e) => e.type === "tool.call.completed" && (e.data as { result?: { taskId?: string } }).result?.taskId);
    const fail = completed.filter((e) => e.type === "tool.call.failed" && (e.data as { code?: string }).code === "task_limit");
    assert.equal(ok.length, 2);
    assert.equal(fail.length, 1);
    await sinty.agent.stopAll(s.id);
    await sinty.agent.idle();
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("message during approval wait is queued (no 409)", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ toolCalls: [{ name: "side__effect", args: { line: "written" } }] }, { text: "ok" }]);
  try {
    const s = sinty.agent.createSession();
    const first = sinty.agent.send(s.id, "write");
    await sinty.agent.idle();
    assert.equal(sinty.journal.activeTurn(s.id)?.status, "blocked");
    const second = sinty.agent.send(s.id, "hurry");
    assert.equal(second.turnId, first.turnId);
    assert.ok(sinty.journal.events(s.id).some((e) => e.type === "message.user" && (e.data as { text: string }).text === "hurry"));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("agent.task accepts wire tool names and runs them (not deny)", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], {
    policy: allowAll,
    plugins: ["recording-provider", "test-tools"],
    config: {
      ...noStall,
      providers: {
        rec: {
          protocol: "rec",
          options: {
            script: {
              "please research": [
                { toolCalls: [{ name: "agent__task", args: { task: "research X", background: true, tools: ["echo__say"] } }] },
                { text: "ack" },
              ],
              "research X": [
                { toolCalls: [{ name: "echo__say", args: { text: "found-it" } }] },
                { text: "child done: found-it" },
              ],
            },
          },
        },
      },
      models: { default: "rec/test-model", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
    },
  });
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "please research");
    await waitFor(() => sinty.journal.events(s.id).find((e) => e.type === "task.completed"));
    await sinty.agent.idle();
    const child = sinty.journal.listSessions(50).find((x) => x.metadata?.parentSessionId === s.id)!;
    assert.deepEqual(child.metadata?.tools, ["echo.say"], "wire names are stored as canonical");
    const denied = sinty.journal.events(child.id).filter((e) => e.type === "tool.call.denied");
    assert.equal(denied.length, 0, "wire allow-list must not deny echo.say");
    const done = sinty.journal.events(child.id).find((e) => e.type === "tool.call.completed");
    assert.ok(done, "echo.say must complete");
    assert.match(JSON.stringify((done!.data as { result: unknown }).result), /found-it/);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("background agent.task mirrors tool progress onto the parent", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], {
    policy: allowAll,
    plugins: ["recording-provider", "test-tools"],
    config: {
      ...noStall,
      providers: {
        rec: {
          protocol: "rec",
          options: {
            script: {
              "please research": [
                { toolCalls: [{ name: "agent__task", args: { task: "research X", background: true, tools: ["echo__say"] } }] },
                { text: "ack" },
              ],
              "research X": [
                { toolCalls: [{ name: "echo__say", args: { text: "found-it" } }] },
                { text: "child done" },
              ],
            },
          },
        },
      },
      models: { default: "rec/test-model", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
    },
  });
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "please research");
    await waitFor(() => sinty.journal.events(s.id).find((e) => e.type === "task.completed"));
    await sinty.agent.idle();
    const progress = sinty.journal.events(s.id).filter((e) => e.type === "task.progress");
    assert.ok(progress.some((e) => (e.data as { phase: string }).phase === "tool.started"), "parent sees tool.started");
    assert.ok(progress.some((e) => (e.data as { phase: string }).phase === "tool.completed"), "parent sees tool.completed");
    assert.ok(
      progress.every((e) => (e.data as { tool?: string }).tool === "echo.say" || (e.data as { phase: string }).phase.startsWith("tool.")),
      "progress carries the child tool name",
    );
  } finally {
    await sinty.stop();
    cleanup();
  }
});
