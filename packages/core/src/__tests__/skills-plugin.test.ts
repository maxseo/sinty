import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { z, type ChatMessage } from "@sinty/sdk";
import { createApp } from "../api/server.js";
import { DEFAULT_ON_PLUGINS, policySchema, type SintyConfig } from "../config.js";
import { CORE_TOOLS, coreToolSchema, RESERVED_TOOL_PREFIXES } from "../coretools.js";
import type { ToolInfo } from "../host/protocol.js";
import { newTrace, traceBase } from "../inspect.js";
import { saveAgent, saveProject } from "../roster.js";
import type { Sinty } from "../sinty.js";
import { boot, FIXTURES, tempHome } from "./helpers.js";

/**
 * Skills left the core for the bundled, default-on `skills` plugin (plan step 7). These tests pin what must not change:
 * tool names, descriptions, schemas, error codes and hints, the catalog text and its place in the static zone of the
 * prompt, and what turns it off (plugins.disabled, an agent card's excludedPlugins).
 */

type Step = { text?: string; toolCalls?: { name: string; args: unknown }[] };

/** The skill tools exactly as packages/core/src/coretools.ts defined them before step 7 (main 150f018). */
const OLD_SKILL_TOOLS: Record<string, { description: string; input: z.ZodType; sideEffects: "read" | "write"; idempotent: boolean }> = {
  "skill.files": {
    description: "List files inside one skill folder: scripts, instructions and SKILL.md.",
    input: z.object({ name: z.string().min(1) }),
    sideEffects: "read",
    idempotent: true,
  },
  "skill.read_file": {
    description: "Read one text file inside a skill. path is relative to the skill folder, for example scripts/boil.js or SKILL.md.",
    input: z.object({ name: z.string().min(1), path: z.string().min(1) }),
    sideEffects: "read",
    idempotent: true,
  },
  "skill.write_file": {
    description: "Create or replace one text file inside a skill: a script, an extra instruction, or SKILL.md. path is relative to the skill folder.",
    input: z.object({ name: z.string().min(1), path: z.string().min(1), text: z.string().min(1) }),
    sideEffects: "write",
    idempotent: true,
  },
  "skill.edit": {
    description: "Replace one unique fragment in a file inside a skill. Read the file first and pass the exact old text. Use this to patch SKILL.md or a script without rewriting the whole file.",
    input: z.object({ name: z.string().min(1), path: z.string().min(1), old: z.string().min(1), replacement: z.string() }),
    sideEffects: "write",
    idempotent: false,
  },
  "skill.write": {
    description: "Create or replace skills/<name>/SKILL.md. The name is the folder. Put a description line in the frontmatter so the next turn can list it.",
    input: z.object({ name: z.string().min(1), text: z.string().min(1).describe("full SKILL.md, including frontmatter") }),
    sideEffects: "write",
    idempotent: true,
  },
  "skill.read": {
    description: "Read one skill's SKILL.md from the skills folder. Use the name from the skills list in the prompt.",
    input: z.object({ name: z.string().min(1) }),
    sideEffects: "read",
    idempotent: true,
  },
};

/** The catalog text the core rendered before step 7 (skills.ts skillCatalog), for the given "- name: description" lines. */
function oldCatalog(items: string[]): string {
  return [
    "Skills you can follow. skill.read loads SKILL.md. skill.files lists the other files. skill.read_file reads one of them.",
    "To change a skill, prefer skill.edit (one unique fragment). skill.write_file replaces or creates a whole file: a script, an instruction, or SKILL.md. skill.write replaces only SKILL.md.",
    "Do not invent steps that the skill does not contain.",
    ...(items.length ? items : ["(none)"]),
  ].join("\n");
}

const policy = policySchema.parse({ defaults: { none: "allow", read: "allow", write: "ask", external: "ask" }, tools: { "skill.*": "allow" } });

function cfg(script: Record<string, Step[]>, extra: Partial<SintyConfig["plugins"]> = {}, plugins: string[] = []): Partial<SintyConfig> {
  return {
    providers: { rec: { protocol: "rec", options: { script } } },
    models: { default: "rec/main", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
    plugins: { enabled: ["recording-provider", ...plugins], config: {}, searchPaths: [FIXTURES], ...extra },
  };
}

const requests = (home: string): { messages: ChatMessage[]; tools: string[] }[] => {
  const file = join(home, "data", "recording-provider", "requests.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => Array.isArray(r.messages)) : [];
};

function addSkill(sinty: Sinty, name: string, description: string): void {
  mkdirSync(join(sinty.paths.skills, name), { recursive: true });
  writeFileSync(join(sinty.paths.skills, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\nStep one.\n`);
}

async function withSinty(config: Partial<SintyConfig>, run: (sinty: Sinty, home: string) => Promise<void>): Promise<void> {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { config, plugins: [], policy });
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

test("skills plugin: on by default, owns the six skill tools with the old names, descriptions and schemas; none left in the core", async () => {
  await withSinty(cfg({}), async (sinty) => {
    assert.ok(DEFAULT_ON_PLUGINS.includes("skills"));
    assert.ok(sinty.config.plugins.enabled.includes("skills"));
    assert.equal(RESERVED_TOOL_PREFIXES["skill."], "skills");
    assert.deepEqual(CORE_TOOLS.filter((t) => t.name.startsWith("skill.")), [], "no skill tool is a core tool any more");
    const proc = sinty.host.plugins.get("skills");
    assert.ok(proc, "skills is running");
    for (const [name, old] of Object.entries(OLD_SKILL_TOOLS)) {
      const t: ToolInfo | undefined = proc.tools.find((x) => x.name === name);
      assert.ok(t, `${name} is registered`);
      assert.equal(sinty.host.toolOwner(name)?.name, "skills");
      assert.equal(t.description, old.description, name);
      assert.equal(t.sideEffects, old.sideEffects, name);
      assert.equal(t.idempotent, old.idempotent, name);
      const { $schema: _s, ...schema } = t.inputSchema;
      assert.deepEqual(schema, coreToolSchema({ name, description: old.description, input: old.input, sideEffects: old.sideEffects, idempotent: old.idempotent }), name);
    }
    const wire = sinty.agent.toolSchemas().filter((t) => t.name.startsWith("skill__")).map((t) => t.name);
    assert.deepEqual(wire, ["skill__edit", "skill__files", "skill__read", "skill__read_file", "skill__write", "skill__write_file"]);
    const supervised = sinty.agent.supervisedTools().find((t) => t.name === "skill.read");
    assert.equal(supervised?.plugin, "skills");
    assert.match(supervised?.docsPath ?? "", /skills[\\/]README\.md$/);
    assert.equal(supervised?.editable, true, "the agent may patch it like tool-web");
  });
});

test("skills plugin: the catalog is message 1, byte for byte the old text, in the static zone; skill.write shows up next step", async () => {
  const write = { name: "skill__write", args: { name: "stew", text: "---\ndescription: Simmer slowly.\n---\n# Stew\n" } };
  await withSinty(cfg({ cook: [{ toolCalls: [write] }, { toolCalls: [{ name: "skill__read", args: { name: "nope" } }] }, { text: "done" }] }), async (sinty, home) => {
    addSkill(sinty, "bake", "Heat the oven first.");
    const s = sinty.agent.createSession().id;
    sinty.agent.send(s, "cook");
    await sinty.agent.idle();
    const [first, second, third] = requests(home);
    assert.ok(first && second && third);
    assert.equal(first.messages[0]!.cacheHint, undefined, "the system prompt carries no hint when a section follows it");
    assert.equal(first.messages[1]!.role, "system");
    assert.equal(first.messages[1]!.content, oldCatalog(["- bake: Heat the oven first."]));
    assert.equal(first.messages[1]!.cacheHint, "static");
    assert.equal(second.messages[1]!.content, oldCatalog(["- bake: Heat the oven first.", "- stew: Simmer slowly."]), "the written skill is listed from the next step");
    assert.ok(existsSync(join(sinty.paths.skills, "stew", "SKILL.md")));
    const events = sinty.journal.events(s);
    assert.equal(events.filter((e) => e.type === "tool.call.approval_requested").length, 0, '"skill.*": allow still applies to the plugin tools');
    const failed = events.find((e) => e.type === "tool.call.failed")?.data as { code: string; message: string; hint?: string } | undefined;
    assert.equal(failed?.code, "not_found");
    assert.equal(failed?.message, "no skill nope");
    assert.equal(failed?.hint, "Use a name from the skills list.");
  });
});

test("skills plugin: a roster agent sees only its ticked skills; excludedPlugins drops the catalog and the tools", async () => {
  await withSinty(cfg({}), async (sinty, home) => {
    addSkill(sinty, "bake", "Heat the oven first.");
    addSkill(sinty, "stew", "Simmer slowly.");
    const cook = saveAgent(sinty.paths, { name: "Cook", skills: ["stew"] });
    const plain = saveAgent(sinty.paths, { name: "Plain", skills: ["stew"], excludedPlugins: ["skills"] });
    const a = chatWith(sinty, cook.id);
    sinty.agent.send(a, "hi", { agentId: cook.id });
    await sinty.agent.idle();
    const b = chatWith(sinty, plain.id);
    sinty.agent.send(b, "hi", { agentId: plain.id });
    await sinty.agent.idle();
    const [ra, rb] = requests(home);
    assert.ok(ra && rb);
    assert.equal(ra.messages[1]!.content, oldCatalog(["- stew: Simmer slowly."]));
    assert.ok(ra.tools.includes("skill__read"));
    assert.ok(!rb.messages.some((m) => m.content.startsWith("Skills you can follow.")), "no catalog for an agent without the plugin");
    assert.equal(rb.messages[0]!.cacheHint, "static", "the system prompt closes the static zone on its own");
    assert.ok(!rb.tools.some((t) => t.startsWith("skill__")), `no skill tools: ${rb.tools.join(",")}`);
  });
});

test("skills plugin: plugins.disabled turns off the catalog, the tools and the skills list", async () => {
  await withSinty(cfg({}, { disabled: ["skills"] }), async (sinty, home) => {
    addSkill(sinty, "bake", "Heat the oven first.");
    assert.equal(sinty.host.plugins.get("skills"), undefined);
    assert.equal(sinty.host.toolOwner("skill.read"), undefined);
    const s = sinty.agent.createSession().id;
    sinty.agent.send(s, "hi");
    await sinty.agent.idle();
    const [r] = requests(home);
    assert.ok(r);
    assert.ok(!r.messages.some((m) => m.content.startsWith("Skills you can follow.")));
    assert.equal(r.messages[0]!.cacheHint, "static");
    const app = createApp(sinty);
    const res = await app.request("/v1/roster/skills", { headers: { authorization: `Bearer ${sinty.secrets.get("api.token")!}` } });
    assert.deepEqual(await res.json(), { skills: [], disabled: true });
  });
});

test("skills plugin: /v1/roster/skills and /p/skills/list list the skills folder", async () => {
  await withSinty(cfg({}), async (sinty) => {
    addSkill(sinty, "bake", "Heat the oven first.");
    const app = createApp(sinty);
    const headers = { authorization: `Bearer ${sinty.secrets.get("api.token")!}` };
    const want = { skills: [{ name: "bake", description: "Heat the oven first." }] };
    assert.deepEqual(await (await app.request("/v1/roster/skills", { headers })).json(), want);
    assert.deepEqual(await (await app.request("/p/skills/list", { headers })).json(), want);
  });
});

test("system sections: one that fails repeats its last good text, so the static zone stays byte-identical", async () => {
  await withSinty(cfg({ go: [{ toolCalls: [{ name: "skill__files", args: { name: "nope" } }] }, { text: "done" }] }, {}, ["section-flaky"]), async (sinty, home) => {
    const s = sinty.agent.createSession().id;
    sinty.agent.send(s, "go");
    await sinty.agent.idle();
    const [first, second] = requests(home);
    assert.ok(first && second);
    assert.equal(first.messages[1]!.content, oldCatalog([]), "skills (order 0) first");
    assert.equal(first.messages[1]!.cacheHint, undefined);
    assert.equal(first.messages[2]!.content, "House rules for everyone.");
    assert.equal(first.messages[2]!.cacheHint, "static", "the last section closes the static zone");
    assert.deepEqual(second.messages.slice(0, 3), first.messages.slice(0, 3), "the failed section repeats its first text");
  });
});

test("skills plugin: another plugin cannot take a skill.* name", async () => {
  const { home, cleanup } = tempHome();
  const { Sinty } = await import("../sinty.js");
  const sinty = new Sinty({ home, config: cfg({}, {}, ["skill-squatter"]) });
  try {
    const { failedPlugins } = await sinty.start();
    const failed = failedPlugins.find((f) => f.plugin === "skill-squatter");
    assert.ok(failed);
    assert.match(failed.error, /skill\.read \(skills\) is reserved for a bundled plugin/);
    assert.equal(sinty.host.toolOwner("skill.read")?.name, "skills");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("context snapshot labels: system sections take their plugin's label; memory and dialogue shift after them", () => {
  const trace = newTrace();
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "system", content: "catalog" },
    { role: "system", content: "rules" },
    { role: "system", content: "mem" },
    { role: "user", content: "hi" },
  ];
  traceBase(trace, messages, [{ kind: "skills", source: "skills", id: "skills/catalog" }, { kind: "system", source: "section-flaky", id: "section-flaky/rules" }], 1);
  assert.deepEqual(trace.labels.map((l) => [l.kind, l.source, l.id]), [
    ["system", "core", "system"],
    ["skills", "skills", "skills/catalog"],
    ["system", "section-flaky", "section-flaky/rules"],
    ["memory", "builtin:sqlite", "memory"],
    ["dialogue", "journal", undefined],
  ]);
});
