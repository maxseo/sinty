import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginManifest } from "@sinty/sdk";
import { agentManifestViolations } from "../agent-plugins.js";
import { policySchema } from "../config.js";
import { resolveFsGrants } from "../host/manifest.js";
import { fileInRoot, parseSessionGrants, resolveSessionPath } from "../host/session-fs.js";
import { resolvePaths } from "../paths.js";
import { projectDir, saveProject } from "../roster.js";
import { boot, find, tempHome } from "./helpers.js";

const allowAll = policySchema.parse({ defaults: { none: "allow", read: "allow", write: "allow", external: "allow" } });

const helloManifest = (fs: { read?: string[]; write?: string[] }): string =>
  JSON.stringify({
    name: "hello",
    version: "0.1.0",
    description: "Reads a session file",
    kinds: ["tool"],
    runtime: "node",
    entry: "index.js",
    permissions: { fs },
    tools: [{ name: "hello.grab", sideEffects: "read" }],
  });

test("a path stays inside its root and a climb is refused", () => {
  const root = join("/tmp", "work", "проект");
  assert.equal(fileInRoot(root, "_inbox/голос.png"), join(root, "_inbox", "голос.png"));
  assert.equal(fileInRoot(root, "../secrets.json"), undefined);
});

test("$SESSION grants parse; $WORKSPACE does not count as a session grant", () => {
  assert.deepEqual(parseSessionGrants(["$DATA", "$SESSION", "$SESSION/_inbox"]), ["$SESSION", "$SESSION/_inbox"]);
  assert.deepEqual(parseSessionGrants(["$WORKSPACE", "$SESSION/../home"]), []);
});

test("resolveSessionPath allows the session root or a $SESSION subfolder, never a sibling project", () => {
  const project = join("/tmp", "workspace", "projects", "demo");
  const other = join("/tmp", "workspace", "projects", "other");
  assert.equal(resolveSessionPath(project, "_inbox/a.png", ["$SESSION"]), join(project, "_inbox", "a.png"));
  assert.equal(resolveSessionPath(project, "_inbox/a.png", ["$SESSION/_inbox"]), join(project, "_inbox", "a.png"));
  assert.equal(resolveSessionPath(project, "_out/a.png", ["$SESSION/_inbox"]), undefined);
  assert.equal(resolveSessionPath(project, join(other, "_inbox", "a.png"), ["$SESSION"]), undefined);
});

test("agent-made plugins may ask for $SESSION but still not $WORKSPACE", () => {
  const ok = {
    name: "hello",
    version: "0.1.0",
    description: "d",
    kinds: ["tool"],
    runtime: "node",
    entry: "index.js",
    permissions: { fs: { read: ["$DATA", "$PLUGIN", "$SESSION", "$SESSION/_inbox"], write: ["$DATA", "$SESSION"] } },
    tools: [{ name: "hello.grab", sideEffects: "read" }],
  } as PluginManifest;
  assert.deepEqual(agentManifestViolations(ok), []);
  const bad = agentManifestViolations({
    ...ok,
    permissions: { fs: { read: ["$WORKSPACE"], write: ["$WORKSPACE"] } },
  });
  assert.ok(bad.some((b) => b.includes("$WORKSPACE")), bad.join(" | "));
});

test("resolveFsGrants does not expand $SESSION into the global workspace", () => {
  const { home, cleanup } = tempHome();
  try {
    const paths = resolvePaths(home);
    const loaded = {
      dir: join(home, "plugins", "hello"),
      bundled: false,
      agentMade: true,
      manifest: JSON.parse(helloManifest({ read: ["$DATA", "$PLUGIN", "$SESSION"], write: ["$DATA"] })) as PluginManifest,
    };
    const grants = resolveFsGrants(paths, loaded);
    assert.ok(!grants.read.includes(paths.workspace), "must not grant the global desk");
    assert.deepEqual(grants.sessionRead, ["$SESSION"]);
    assert.deepEqual(grants.sessionWrite, []);
  } finally {
    cleanup();
  }
});

test("grabby.read in a project session returns a file from that project _inbox", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(
    home,
    [
      { toolCalls: [{ name: "grabby__read", args: { path: "_inbox/note.txt" } }] },
      { echoLastTool: true },
    ],
    { plugins: ["fake-provider", "grabby"], policy: allowAll },
  );
  try {
    const project = saveProject(sinty.paths, { name: "Demo" });
    mkdirSync(join(projectDir(sinty.paths, project), "_inbox"), { recursive: true });
    writeFileSync(join(projectDir(sinty.paths, project), "_inbox", "note.txt"), "from-project");
    const session = sinty.agent.createSession({ projectId: project.id });
    sinty.agent.send(session.id, "read the inbox file");
    await sinty.agent.idle();
    assert.equal(find<{ text: string }>(sinty.journal.events(session.id), "message.agent")?.text, "last tool: from-project");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("grabby.read cannot escape from a project into another project", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(
    home,
    [{ toolCalls: [{ name: "grabby__read", args: { path: "../other/_inbox/secret.txt" } }] }],
    { plugins: ["fake-provider", "grabby"], policy: allowAll },
  );
  try {
    const project = saveProject(sinty.paths, { name: "Demo" });
    const other = saveProject(sinty.paths, { name: "Other" });
    mkdirSync(join(projectDir(sinty.paths, other), "_inbox"), { recursive: true });
    writeFileSync(join(projectDir(sinty.paths, other), "_inbox", "secret.txt"), "from-other");
    const session = sinty.agent.createSession({ projectId: project.id });
    sinty.agent.send(session.id, "read the other project");
    await sinty.agent.idle();
    const failed = sinty.journal.events(session.id).find((e) => e.type === "tool.call.failed")?.data as { message?: string } | undefined;
    assert.ok(failed?.message && /session|outside|не найден|path/i.test(failed.message), JSON.stringify(failed));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("without a project grabby.read uses the global workspace", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(
    home,
    [
      { toolCalls: [{ name: "grabby__read", args: { path: "note.txt" } }] },
      { echoLastTool: true },
    ],
    { plugins: ["fake-provider", "grabby"], policy: allowAll },
  );
  try {
    writeFileSync(join(sinty.paths.workspace, "note.txt"), "from-global");
    const session = sinty.agent.createSession();
    sinty.agent.send(session.id, "read the workspace file");
    await sinty.agent.idle();
    assert.equal(find<{ text: string }>(sinty.journal.events(session.id), "message.agent")?.text, "last tool: from-global");
  } finally {
    await sinty.stop();
    cleanup();
  }
});
