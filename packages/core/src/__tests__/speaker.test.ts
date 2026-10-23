import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ChatMessage, ContextSnapshot } from "@sinty/sdk";
import type { SintyConfig } from "../config.js";
import { saveAgent, saveProject } from "../roster.js";
import type { Sinty } from "../sinty.js";
import { boot, FIXTURES, tempHome } from "./helpers.js";

/** Which roster agent speaks in a chat: the chat's own members first, then the project, then the global AGENTS.md. */

type Step = { text?: string; toolCalls?: { name: string; args: unknown }[] };

function cfg(script: Record<string, Step[]> = {}): Partial<SintyConfig> {
  return {
    providers: { rec: { protocol: "rec", options: { script } } },
    models: { default: "rec/main", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
    plugins: { enabled: ["recording-provider", "inspect-test"], config: {}, searchPaths: [FIXTURES], inspect: ["inspect-test"] },
  };
}

function lines<T>(file: string): T[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : [];
}

const requests = (home: string): { messages: ChatMessage[] }[] =>
  lines<{ messages?: ChatMessage[] }>(join(home, "data", "recording-provider", "requests.jsonl")).filter((r): r is { messages: ChatMessage[] } => Array.isArray(r.messages));

async function snapshots(home: string, want: number): Promise<ContextSnapshot[]> {
  const file = join(home, "data", "inspect-test", "snapshots.jsonl");
  for (let i = 0; i < 100 && lines(file).length < want; i++) await sleep(20);
  return lines<ContextSnapshot>(file);
}

async function withSinty(script: Record<string, Step[]>, run: (sinty: Sinty, home: string) => Promise<void>): Promise<void> {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { config: cfg(script), plugins: [] });
  writeFileSync(sinty.paths.agents, "GLOBAL-PERSONA-MARKER");
  try {
    await run(sinty, home);
  } finally {
    await sinty.stop();
    cleanup();
  }
}

const agentMessage = (sinty: Sinty, sessionId: string): { agentId?: string; agentName?: string } =>
  sinty.journal.events(sessionId).findLast((e) => e.type === "message.agent")!.data as { agentId?: string; agentName?: string };

test("speaker: the chat's own agentIds win when the project has no agents (repro of the empty project)", async () => {
  const write = { name: "memory__write", args: { text: "Alpha prefers short answers.", tier: "profile", scope: "agent", about: "work" } };
  await withSinty({ hello: [{ toolCalls: [write] }, { text: "saved" }] }, async (sinty, home) => {
    const alpha = saveAgent(sinty.paths, { name: "Alpha", persona: "ALPHA-PERSONA-MARKER" });
    saveAgent(sinty.paths, { name: "Beta", persona: "BETA-PERSONA-MARKER" });
    const project = saveProject(sinty.paths, { name: "first" });
    assert.deepEqual([project.agentIds, project.leadId], [[], ""]);
    const s = sinty.agent.createSession({ projectId: project.id, metadata: { agentIds: [alpha.id] } });
    sinty.agent.send(s.id, "hello", { agentId: alpha.id });
    await sinty.agent.idle();

    const [first] = requests(home);
    assert.match(first!.messages[0]!.content, /^ALPHA-PERSONA-MARKER/);
    assert.doesNotMatch(first!.messages[0]!.content, /GLOBAL-PERSONA-MARKER/);
    assert.deepEqual(agentMessage(sinty, s.id), { text: "saved", agentId: alpha.id, agentName: "Alpha" });
    const snaps = await snapshots(home, 2);
    assert.equal(snaps[0]!.agentId, alpha.id);
    assert.deepEqual(snaps[0]!.persona, { source: "agent", agentName: "Alpha" });
    // Agent-scoped memory belongs to Alpha, not to config.agent.name.
    const own = sinty.memory.builtin.store.all({ agentId: alpha.id }).map((f) => [f.text, f.scope]);
    assert.deepEqual(own, [["Alpha prefers short answers.", "agent"]]);
    assert.deepEqual(sinty.memory.builtin.store.all({ agentId: "Sinty" }), []);
  });
});

test("speaker: a chat without a project but with agentIds gets that agent", async () => {
  await withSinty({}, async (sinty, home) => {
    const beta = saveAgent(sinty.paths, { name: "Beta", persona: "BETA-PERSONA-MARKER" });
    const s = sinty.agent.createSession({ metadata: { agentIds: [beta.id] } });
    sinty.agent.send(s.id, "hi");
    await sinty.agent.idle();
    assert.match(requests(home)[0]!.messages[0]!.content, /^BETA-PERSONA-MARKER/);
    assert.equal(agentMessage(sinty, s.id).agentName, "Beta");
  });
});

test("speaker: an agentId that is not a chat member is ignored; the lead, else the first member, answers", async () => {
  await withSinty({}, async (sinty, home) => {
    const alpha = saveAgent(sinty.paths, { name: "Alpha", persona: "ALPHA-PERSONA-MARKER" });
    const beta = saveAgent(sinty.paths, { name: "Beta", persona: "BETA-PERSONA-MARKER" });
    const gamma = saveAgent(sinty.paths, { name: "Gamma", persona: "GAMMA-PERSONA-MARKER" });
    // Project members with a lead: the lead answers when the asked agent is not a member.
    const project = saveProject(sinty.paths, { name: "team", agentIds: [alpha.id, beta.id], leadId: beta.id });
    const a = sinty.agent.createSession({ projectId: project.id });
    sinty.agent.send(a.id, "one", { agentId: gamma.id });
    await sinty.agent.idle();
    assert.match(requests(home)[0]!.messages[0]!.content, /^BETA-PERSONA-MARKER/);
    // The asked member answers.
    sinty.agent.send(a.id, "two", { agentId: alpha.id });
    await sinty.agent.idle();
    assert.match(requests(home)[1]!.messages[0]!.content, /^ALPHA-PERSONA-MARKER/);
    // Chat members that do not include the project lead: the first chat member answers.
    const b = sinty.agent.createSession({ projectId: project.id, metadata: { agentIds: [gamma.id, alpha.id] } });
    sinty.agent.send(b.id, "three", { agentId: beta.id });
    await sinty.agent.idle();
    assert.match(requests(home)[2]!.messages[0]!.content, /^GAMMA-PERSONA-MARKER/);
  });
});

test("speaker: no agents in the chat or the project, or only deleted ones: global AGENTS.md and the default name", async () => {
  await withSinty({}, async (sinty, home) => {
    const project = saveProject(sinty.paths, { name: "empty" });
    const s = sinty.agent.createSession({ projectId: project.id, metadata: { agentIds: ["agt_deleted"] } });
    sinty.agent.send(s.id, "hi", { agentId: "agt_deleted" });
    await sinty.agent.idle();
    assert.match(requests(home)[0]!.messages[0]!.content, /^GLOBAL-PERSONA-MARKER/);
    assert.deepEqual(agentMessage(sinty, s.id), { text: "ok: hi" });
    const [snap] = await snapshots(home, 1);
    assert.equal(snap!.agentId, "Sinty");
    assert.deepEqual(snap!.persona, { source: "global" });
  });
});

test("speaker: agent.task child with projectId inherits parent speaker when project has no agents", async () => {
  await withSinty({}, async (sinty, home) => {
    const alpha = saveAgent(sinty.paths, { name: "Alpha", persona: "ALPHA-PERSONA-MARKER", model: "rec/alpha" });
    const project = saveProject(sinty.paths, { name: "empty-for-child" });
    assert.deepEqual([project.agentIds, project.leadId], [[], ""]);
    const parent = sinty.agent.createSession({ projectId: project.id, metadata: { agentIds: [alpha.id] } });
    // Mimic agent.task: child copies projectId, has parentSessionId, no own agentIds.
    const child = sinty.agent.createSession({
      projectId: project.id,
      metadata: { parentSessionId: parent.id, tools: ["echo__say"] },
    });
    sinty.agent.send(child.id, "hi");
    await sinty.agent.idle();
    assert.match(requests(home)[0]!.messages[0]!.content, /^ALPHA-PERSONA-MARKER/);
    assert.equal(agentMessage(sinty, child.id).agentName, "Alpha");
    assert.equal(agentMessage(sinty, child.id).agentId, alpha.id);
  });
});

test("speaker: project agentIds still win over parent inherit for a child", async () => {
  await withSinty({}, async (sinty, home) => {
    const alpha = saveAgent(sinty.paths, { name: "Alpha", persona: "ALPHA-PERSONA-MARKER" });
    const beta = saveAgent(sinty.paths, { name: "Beta", persona: "BETA-PERSONA-MARKER" });
    const project = saveProject(sinty.paths, { name: "with-agents", agentIds: [beta.id], leadId: beta.id });
    const parent = sinty.agent.createSession({ projectId: project.id, metadata: { agentIds: [alpha.id] } });
    const child = sinty.agent.createSession({
      projectId: project.id,
      metadata: { parentSessionId: parent.id },
    });
    sinty.agent.send(child.id, "hi");
    await sinty.agent.idle();
    // Child has no own agentIds → project members (Beta), not parent Alpha.
    assert.match(requests(home)[0]!.messages[0]!.content, /^BETA-PERSONA-MARKER/);
    assert.equal(agentMessage(sinty, child.id).agentName, "Beta");
  });
});