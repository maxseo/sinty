import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatMessage } from "@sinty/sdk";
import { createApp } from "../api/server.js";
import { policySchema, type SintyConfig } from "../config.js";
import { agentHasPlugin, saveAgent, saveProject, setSharedPlugins } from "../roster.js";
import type { Sinty } from "../sinty.js";
import { boot, FIXTURES, tempHome } from "./helpers.js";

/**
 * Which plugins an agent card gets. Regression (2026-10-21, installed main 06dd3da): agent cards saved before tool-web
 * existed carry an explicit plugin list without it, so every web.search was denied with "this plugin is not on this
 * agent", and the agent.task child got no tools at all.
 */

type Step = { text?: string; toolCalls?: { name: string; args: unknown }[] };

/** The plugin list Max's agent cards had: saved from the shared defaults before web moved out of the core. */
const LEGACY_LIST = ["ui-web", "provider-openai-compat", "provider-anthropic", "tool-fs", "kanban", "context-inspector", "recording-provider"];

// web.* asks (external), agent.task and memory are allowed: a web call that reaches policy blocks on approval.
const policy = policySchema.parse({ defaults: { none: "allow", read: "allow", write: "allow", external: "ask" } });

function cfg(script: Record<string, Step[]>): Partial<SintyConfig> {
  return {
    providers: { rec: { protocol: "rec", options: { script } } },
    models: { default: "rec/main", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
    plugins: { enabled: ["recording-provider"], disabled: [], config: {}, searchPaths: [FIXTURES] },
  };
}

const requests = (home: string): { messages: ChatMessage[]; tools: string[] }[] => {
  const file = join(home, "data", "recording-provider", "requests.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => Array.isArray(r.messages)) : [];
};

async function withSinty(script: Record<string, Step[]>, run: (sinty: Sinty, home: string) => Promise<void>): Promise<void> {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { config: cfg(script), plugins: [], policy });
  try {
    await run(sinty, home);
  } finally {
    await sinty.stop();
    cleanup();
  }
}

function chatWith(sinty: Sinty, agentId: string): string {
  const project = saveProject(sinty.paths, { name: `p-${agentId}`, agentIds: [agentId], leadId: agentId });
  return sinty.agent.createSession({ projectId: project.id, metadata: { agentIds: [agentId] } }).id;
}

const WEB = { name: "web__search", args: { query: "EYU2 electric scooter" } };

test("agent plugins: default-on plugins ignore the card's plugin list; only excludedPlugins removes them", () => {
  const base = { id: "a", name: "A", specialization: "", summary: "", avatar: "", persona: "", model: "", fallback: "", serviceModel: "", compress: "", facts: "", stallSeconds: null, skills: [] };
  const legacy = { ...base, plugins: ["tool-fs"], excludedPlugins: [] };
  assert.equal(agentHasPlugin(legacy, "tool-web", ["tool-web"], null), true);
  assert.equal(agentHasPlugin(legacy, "kanban", ["tool-web"], null), false, "optional plugins still follow the card");
  assert.equal(agentHasPlugin(legacy, "tool-fs", ["tool-web"], null), true);
  assert.equal(agentHasPlugin({ ...legacy, excludedPlugins: ["tool-web"] }, "tool-web", ["tool-web"], null), false);
  const empty = { ...base, plugins: [], excludedPlugins: [] };
  assert.equal(agentHasPlugin(empty, "tool-web", ["tool-web"], ["tool-fs"]), true, "a shared list saved before tool-web does not drop it");
  assert.equal(agentHasPlugin(empty, "kanban", ["tool-web"], ["tool-fs"]), false);
});

test("agent plugins: an agent with an explicit (pre-tool-web) plugin list still gets the web tools", async () => {
  await withSinty({ "find eyu2": [{ toolCalls: [WEB] }, { text: "done" }] }, async (sinty, home) => {
    setSharedPlugins(sinty.paths, LEGACY_LIST);
    const agent = saveAgent(sinty.paths, { name: "Синтия", plugins: LEGACY_LIST });
    const s = chatWith(sinty, agent.id);
    sinty.agent.send(s, "find eyu2", { agentId: agent.id });
    await sinty.agent.idle();
    const first = requests(home)[0]!;
    assert.ok(first.tools.includes("web__search"), `web tools are offered: ${first.tools.join(",")}`);
    const events = sinty.journal.events(s);
    assert.equal(events.filter((e) => e.type === "tool.call.denied").length, 0, "web.search is not denied");
    assert.ok(events.some((e) => e.type === "tool.call.approval_requested" && (e.data as { tool: string }).tool === "web.search"), "it reaches the normal policy (ask)");
  });
});

test("agent plugins: an agent that excludes tool-web has no web tools, and a web call is denied", async () => {
  await withSinty({ "find eyu2": [{ toolCalls: [WEB] }, { text: "done" }] }, async (sinty, home) => {
    const agent = saveAgent(sinty.paths, { name: "Offline", plugins: LEGACY_LIST, excludedPlugins: ["tool-web"] });
    const s = chatWith(sinty, agent.id);
    sinty.agent.send(s, "find eyu2", { agentId: agent.id });
    await sinty.agent.idle();
    assert.ok(!requests(home)[0]!.tools.some((t) => t.startsWith("web__")));
    const denied = sinty.journal.events(s).find((e) => e.type === "tool.call.denied");
    assert.equal((denied?.data as { note?: string } | undefined)?.note, "this plugin is not on this agent");
  });
});

test("agent plugins: an agent.task child works as its parent's agent and gets the listed tools (wire names)", async () => {
  const script = {
    go: [{ toolCalls: [{ name: "agent__task", args: { task: "look up eyu2" } }] }, { text: "parent done" }],
    "look up eyu2": [{ text: "child done" }],
  };
  await withSinty(script, async (sinty, home) => {
    const web = saveAgent(sinty.paths, { name: "Web", persona: "WEB-PERSONA-MARKER", plugins: LEGACY_LIST });
    const s = chatWith(sinty, web.id);
    sinty.agent.send(s, "go", { agentId: web.id });
    await sinty.agent.idle();
    const child = requests(home).find((r) => r.messages.some((m) => m.role === "user" && m.content === "look up eyu2"))!;
    assert.ok(child, "the child turn ran");
    assert.deepEqual([...child.tools].sort(), ["memory__recall", "skill__read", "web__links", "web__read", "web__search"], "the child is offered exactly its list");
    assert.match(child.messages[0]!.content, /WEB-PERSONA-MARKER/, "the child speaks as the parent's agent");
    const childSession = sinty.journal.listSessions().find((x) => x.metadata?.parentSessionId === s)!;
    assert.ok(sinty.journal.events(childSession.id).every((e) => e.type !== "memory.snapshot" || (e.data as { agentId: string }).agentId === web.id), "child memory is scoped to the parent's agent");
    assert.equal(sinty.journal.events(s).filter((e) => e.type === "memory.snapshot").length, 1, "the child never writes a snapshot into the parent's chat");

    const offline = saveAgent(sinty.paths, { name: "Offline", plugins: LEGACY_LIST, excludedPlugins: ["tool-web"] });
    const s2 = chatWith(sinty, offline.id);
    sinty.agent.send(s2, "go", { agentId: offline.id });
    await sinty.agent.idle();
    const child2 = requests(home).filter((r) => r.messages.some((m) => m.role === "user" && m.content === "look up eyu2")).at(-1)!;
    assert.deepEqual([...child2.tools].sort(), ["memory__recall", "skill__read"], "the child inherits the parent's exclusion");
  });
});

test("agent plugins: the API marks tool-web as default-on for everyone and keeps an agent's exclusion", async () => {
  await withSinty({}, async (sinty) => {
    const app = createApp(sinty);
    const auth = { authorization: `Bearer ${sinty.secrets.get("api.token")!}`, "content-type": "application/json" };
    setSharedPlugins(sinty.paths, LEGACY_LIST);
    const { plugins } = (await (await app.request("/v1/plugins", { headers: auth })).json()) as { plugins: { name: string; defaultOn?: boolean; forAll?: boolean }[] };
    const web = plugins.find((p) => p.name === "tool-web");
    assert.deepEqual([web?.defaultOn, web?.forAll], [true, true], "a shared list saved before tool-web does not hide it");
    assert.equal(plugins.find((p) => p.name === "recording-provider")?.defaultOn, false);
    const created = (await (await app.request("/v1/roster/agents", { method: "POST", headers: auth, body: JSON.stringify({ name: "X", plugins: ["tool-fs"], excludedPlugins: ["tool-web"] }) })).json()) as { id: string; excludedPlugins: string[] };
    assert.deepEqual(created.excludedPlugins, ["tool-web"]);
    const updated = (await (await app.request(`/v1/roster/agents/${created.id}`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "X", summary: "changed" }) })).json()) as { excludedPlugins: string[] };
    assert.deepEqual(updated.excludedPlugins, ["tool-web"], "an update without the field keeps the exclusion");
  });
});
