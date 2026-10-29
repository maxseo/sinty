import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginManifest } from "@sinty/sdk";
import { agentManifestViolations } from "../agent-plugins.js";
import { policySchema } from "../config.js";
import { boot, find, tempHome, types } from "./helpers.js";

const allowAll = policySchema.parse({ defaults: { none: "allow", read: "allow", write: "allow", external: "allow" } });

const manifest = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    name: "hello",
    version: "0.1.0",
    description: "Greets people",
    kinds: ["tool"],
    runtime: "node",
    entry: "index.js",
    permissions: { fs: { read: ["$DATA"], write: ["$DATA"] } },
    tools: [{ name: "hello.greet", sideEffects: "none" }],
    ...extra,
  });

const code = (extra = ""): string => `import { definePlugin, z } from "@sinty/sdk";
export default definePlugin({
  name: "hello",
  setup(ctx) {
    ctx.tool({ name: "hello.greet", description: "says hello", input: z.object({ who: z.string() }), sideEffects: "none", idempotent: true, async run({ who }) { return { content: "hello " + who }; } });
    ${extra}
  },
});
`;

test("rules for agent-written plugins: no shell, env, foreign kinds, paths outside $DATA or core-named tools", () => {
  const bad = agentManifestViolations({
    name: "x-tool",
    version: "0.1.0",
    description: "d",
    kinds: ["tool", "provider"],
    runtime: "node",
    entry: "index.js",
    editable: false,
    permissions: { shell: true, browser: true, env: ["PATH"], context: ["inspect"], agent: ["sessions.write"], fs: { write: ["$WORKSPACE"], read: ["$DATA/../other"] } },
    tools: [{ name: "fs.read", sideEffects: "read", defaultPolicy: "allow" }],
    ui: { tabs: [{ id: "board", title: "B", builtin: "board" }] },
  } as unknown as PluginManifest);
  for (const word of ["provider", "editable", "shell", "browser", "env", "context", "sessions.write", "$WORKSPACE", "$DATA/../other", "fs.read", "defaultPolicy", "builtin"]) {
    assert.ok(bad.some((b) => b.includes(word)), `${word} in ${bad.join(" | ")}`);
  }
  assert.deepEqual(agentManifestViolations(JSON.parse(manifest()) as PluginManifest), []);
});

test("plugin.create: the agent writes a plugin, a human must approve it even under allow-all, then it runs", async () => {
  const { home, cleanup } = tempHome();
  const files = [
    { path: "sinty.plugin.json", content: manifest() },
    { path: "index.js", content: code() },
  ];
  const sinty = await boot(
    home,
    [
      { toolCalls: [{ name: "plugin__create", args: { plugin: "hello", reason: "greet people by name", files } }] },
      { toolCalls: [{ name: "plugin__apply_patch", args: { patchId: "$last.patchId" } }] },
      { toolCalls: [{ name: "hello__greet", args: { who: "Max" } }] },
      { echoLastTool: true },
    ],
    { plugins: ["fake-provider"], policy: allowAll },
  );
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "make a greeter");
    await sinty.agent.idle();
    const events = sinty.journal.events(s.id);
    assert.equal(find<{ ok: boolean }>(events, "plugin.patch.tested")?.ok, true);
    assert.ok(!existsSync(join(home, "plugins", "hello")), "nothing is installed before a human says yes");
    const req = find<{ callId: string; tool: string }>(events, "tool.call.approval_requested")!;
    assert.equal(req.tool, "plugin.apply_patch");

    sinty.agent.decide(s.id, req.callId, "approve", { kind: "human", id: "test" });
    await sinty.agent.idle();
    const after = sinty.journal.events(s.id);
    assert.ok(types(after).includes("plugin.patch.applied"));
    assert.equal(find<{ text: string }>(after, "message.agent")?.text, "last tool: hello Max");
    assert.equal(sinty.host.plugins.get("hello")?.loaded.agentMade, true);
    assert.deepEqual(JSON.parse(readFileSync(join(home, "plugins", ".agent-made.json"), "utf8")), ["hello"]);
    assert.match(readFileSync(join(home, "config.yaml"), "utf8"), /- hello/);

    const widen = await sinty.patches.propose(s.id, { plugin: "hello", reason: "needs to run programs", files: [{ path: "sinty.plugin.json", content: manifest({ permissions: { shell: true } }) }] });
    assert.equal(widen.status, "failed_tests");
    assert.match(widen.testOutput, /permissions\.shell is not allowed/);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("plugin.create refuses existing names, rule breaks and public routes outside a tab page", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { plugins: ["fake-provider"] });
  try {
    const s = sinty.agent.createSession();
    await assert.rejects(sinty.patches.create(s.id, { plugin: "fake-provider", reason: "take a name", files: [{ path: "sinty.plugin.json", content: "{}" }, { path: "index.js", content: "" }] }), /already exists/);

    const env = await sinty.patches.create(s.id, { plugin: "hello", reason: "read PATH", files: [{ path: "sinty.plugin.json", content: manifest({ permissions: { env: ["PATH"] } }) }, { path: "index.js", content: code() }] });
    assert.equal(env.status, "failed_tests");
    assert.match(env.testOutput, /permissions\.env is not allowed/);

    const open = await sinty.patches.create(s.id, {
      plugin: "hello",
      reason: "open endpoint",
      files: [
        { path: "sinty.plugin.json", content: manifest() },
        { path: "index.js", content: code(`ctx.http({ method: "GET", path: "/dump", public: true, handler: () => new Response("x") });`) },
      ],
    });
    assert.equal(open.status, "failed_tests");
    assert.match(open.testOutput, /may not be public/);
    assert.ok(!existsSync(join(home, "plugins", "hello")));
  } finally {
    await sinty.stop();
    cleanup();
  }
});
