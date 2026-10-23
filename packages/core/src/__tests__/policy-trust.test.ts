import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { CORE_TOOLS } from "../coretools.js";
import { detectPolicyTrustPhrase } from "../policy-trust.js";
import { boot, find, tempHome } from "./helpers.js";

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v as T;
    await sleep(20);
  }
  throw new Error("timeout");
}

test("detectPolicyTrustPhrase matches RU and EN intent phrases", () => {
  assert.equal(detectPolicyTrustPhrase("не спрашивай, делай всё что нужно"), true);
  assert.equal(detectPolicyTrustPhrase("Разрешаю всё в этом чате"), true);
  assert.equal(detectPolicyTrustPhrase("без подтверждений пожалуйста"), true);
  assert.equal(detectPolicyTrustPhrase("just do it, don't ask"), true);
  assert.equal(detectPolicyTrustPhrase("please search the web for coffee"), false);
  assert.equal(detectPolicyTrustPhrase(""), false);
});

test("grantPolicyTrust skips policy ask for write tools", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ toolCalls: [{ name: "side__effect", args: { line: "trusted" } }] }, { text: "ok" }]);
  try {
    const s = sinty.agent.createSession();
    sinty.agent.grantPolicyTrust(s.id, { kind: "human", id: "user" }, "test grant");
    assert.ok(find(sinty.journal.events(s.id), "session.policy_grant"));
    assert.equal(sinty.journal.getSession(s.id)?.metadata?.policyTrust, true);

    sinty.agent.send(s.id, "write");
    await sinty.agent.idle();
    const events = sinty.journal.events(s.id);
    assert.ok(!events.some((e) => e.type === "tool.call.approval_requested"), "no approval_requested under trust");
    const approved = events.filter((e) => e.type === "tool.call.approved");
    assert.ok(approved.some((e) => (e.data as { note?: string }).note === "session trust"));
    assert.ok(events.some((e) => e.type === "tool.call.completed"));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("user trust phrase grants session trust before the turn runs", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ toolCalls: [{ name: "side__effect", args: { line: "from-phrase" } }] }, { text: "ok" }]);
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "не спрашивай, пиши в файл");
    await sinty.agent.idle();
    assert.equal(sinty.journal.getSession(s.id)?.metadata?.policyTrust, true);
    assert.ok(sinty.journal.events(s.id).some((e) => e.type === "session.policy_grant"));
    assert.ok(!sinty.journal.events(s.id).some((e) => e.type === "tool.call.approval_requested"));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("remember on approve grants trust and clears waiting asks", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ toolCalls: [{ name: "side__effect", args: { line: "remembered" } }] }, { text: "ok" }]);
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "write");
    await sinty.agent.idle();
    const pending = await waitFor(() => {
      const p = sinty.agent.pending(s.id);
      return p?.reason === "approval" && p.approvals[0] ? p : undefined;
    });
    sinty.agent.decide(s.id, pending.approvals[0]!.callId, "approve", { kind: "human", id: "user" }, "remember", { remember: true });
    await sinty.agent.idle();
    assert.equal(sinty.journal.getSession(s.id)?.metadata?.policyTrust, true);
    assert.ok(sinty.journal.events(s.id).some((e) => e.type === "session.policy_grant"));
    assert.ok(sinty.journal.events(s.id).some((e) => e.type === "tool.call.completed"));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("agent.task description documents background opt-in", () => {
  const t = CORE_TOOLS.find((x) => x.name === "agent.task");
  assert.ok(t);
  assert.match(t!.description, /background: true only/i);
});
