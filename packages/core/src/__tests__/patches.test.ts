import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { policySchema } from "../config.js";
import { git } from "../git.js";
import { FIXTURES, boot, find, tempHome, types } from "./helpers.js";

const PLUGINS = ["fake-provider", "test-tools", "flaky", "locked"];
const allowAll = policySchema.parse({ defaults: { none: "allow", read: "allow", write: "allow", external: "allow" } });
const original = readFileSync(join(FIXTURES, "flaky", "index.js"), "utf8");
const fixed = original.replace("const BROKEN = true;", "const BROKEN = false;");

test("patch: the agent proposes a fix, a human approves it, the forked plugin reloads and works", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(
    home,
    [
      { toolCalls: [{ name: "plugin__propose_patch", args: { plugin: "flaky", reason: "BROKEN flag left on", files: [{ path: "index.js", content: fixed }] } }] },
      { toolCalls: [{ name: "plugin__apply_patch", args: { patchId: "$last.patchId" } }] },
      { toolCalls: [{ name: "flaky__get", args: {} }] },
      { echoLastTool: true },
    ],
    { plugins: PLUGINS },
  );
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "fix flaky");
    await sinty.agent.idle();
    assert.equal(sinty.journal.activeTurn(s.id)?.status, "blocked");
    const events = sinty.journal.events(s.id);
    const tested = find<{ ok: boolean; output: string }>(events, "plugin.patch.tested")!;
    assert.equal(tested.ok, true);
    assert.match(tested.output, /load: ok, tools \[flaky\.get\]/);
    assert.ok(!existsSync(join(home, "plugins", "flaky")), "nothing changes before apply");

    const req = find<{ callId: string; tool: string }>(events, "tool.call.approval_requested")!;
    assert.equal(req.tool, "plugin.apply_patch");
    sinty.agent.decide(s.id, req.callId, "approve", { kind: "human", id: "test" });
    await sinty.agent.idle();

    const after = sinty.journal.events(s.id);
    assert.ok(types(after).includes("plugin.patch.applied"));
    assert.equal(find<{ text: string }>(after, "message.agent")?.text, "last tool: 42");
    assert.match(readFileSync(join(home, "plugins", "flaky", "index.js"), "utf8"), /BROKEN = false/);
    const log = await git(join(home, "plugins"), "log", "--format=%s");
    assert.match(log, /^patch pat_\S+ flaky: BROKEN flag left on\nfork flaky@0\.0\.1 from bundled\ninit plugin repository$/);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("patch: a bundled TypeScript plugin is forked and runs from src through type stripping", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { plugins: [...PLUGINS, "tool-fs"] });
  try {
    const s = sinty.agent.createSession();
    const src = (sinty.patches.read("tool-fs", "src/index.ts") as { content: string }).content;
    const p = await sinty.patches.propose(s.id, { plugin: "tool-fs", reason: "touch a comment", files: [{ path: "src/index.ts", content: `// patched\n${src}` }] });
    assert.equal(p.status, "ready", p.testOutput);
    assert.equal(p.permissionsChanged, false);
    assert.equal((await sinty.patches.apply(p.id)).applied, true);
    const manifest = JSON.parse(readFileSync(join(home, "plugins", "tool-fs", "sinty.plugin.json"), "utf8")) as { entry: string };
    assert.equal(manifest.entry, "src/index.ts");
    assert.equal(sinty.host.plugins.get("tool-fs")?.loaded.bundled, false);
    assert.ok(sinty.host.toolOwner("fs.read"));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("patch: failing tests or a broken entry are reported and cannot be applied", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { plugins: PLUGINS });
  try {
    const s = sinty.agent.createSession();
    const failing = await sinty.patches.propose(s.id, {
      plugin: "flaky",
      reason: "add a failing test",
      files: [{ path: "index.test.js", content: 'console.log("checking"); process.exit(3);' }],
    });
    assert.equal(failing.status, "failed_tests");
    assert.match(failing.testOutput, /index\.test\.js: FAIL \(exit 3\)\nchecking/);
    await assert.rejects(sinty.patches.apply(failing.id), /is failed_tests/);

    const broken = await sinty.patches.propose(s.id, { plugin: "flaky", reason: "syntax error here", files: [{ path: "index.js", content: "export default {" }] });
    assert.equal(broken.status, "failed_tests");
    assert.match(broken.testOutput, /^load: /);

    const sandboxed = await sinty.patches.propose(s.id, {
      plugin: "flaky",
      reason: "test tries to escape",
      files: [{ path: "escape.test.js", content: `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(home, "config.yaml"))}, "pwned");` }],
    });
    assert.equal(sandboxed.status, "failed_tests");
    assert.match(sandboxed.testOutput, /ERR_ACCESS_DENIED/);
    assert.doesNotMatch(readFileSync(join(home, "config.yaml"), "utf8"), /pwned/);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("patch: paths outside the plugin and plugins marked editable: false are refused", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { plugins: PLUGINS });
  try {
    const s = sinty.agent.createSession();
    for (const path of ["../flaky2/index.js", "node_modules/x.js", "C:/x.js", "/etc/passwd"]) {
      await assert.rejects(sinty.patches.propose(s.id, { plugin: "flaky", reason: "bad path", files: [{ path, content: "" }] }), { code: "bad_path" }, path);
    }
    await assert.rejects(sinty.patches.propose(s.id, { plugin: "locked", reason: "try anyway", files: [{ path: "index.js", content: "" }] }), { code: "not_editable" });
    await assert.rejects(sinty.patches.propose(s.id, { plugin: "nope", reason: "missing", files: [{ path: "index.js", content: "" }] }), { code: "not_found" });
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("patch: a permission change always needs approval, even when policy allows apply", async () => {
  const { home, cleanup } = tempHome();
  const first = await boot(home, [], { plugins: PLUGINS });
  let patchId: string;
  try {
    const s = first.agent.createSession();
    const manifest = JSON.parse(readFileSync(join(FIXTURES, "flaky", "sinty.plugin.json"), "utf8")) as Record<string, unknown>;
    manifest.permissions = { fs: { write: ["$WORKSPACE"] } };
    const p = await first.patches.propose(s.id, { plugin: "flaky", reason: "needs workspace", files: [{ path: "sinty.plugin.json", content: JSON.stringify(manifest) }] });
    assert.equal(p.status, "ready");
    assert.equal(p.permissionsChanged, true);
    patchId = p.id;
  } finally {
    await first.stop();
  }
  const sinty = await boot(home, [{ toolCalls: [{ name: "plugin__apply_patch", args: { patchId } }] }, { text: "ok" }], { policy: allowAll, plugins: PLUGINS });
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "apply");
    await sinty.agent.idle();
    const req = find<{ reason: string }>(sinty.journal.events(s.id), "tool.call.approval_requested");
    assert.match(req?.reason ?? "", /changes the permissions of plugin flaky/);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("patch: the canary rolls back a patch whose calls keep failing", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { plugins: PLUGINS });
  try {
    const s = sinty.agent.createSession();
    const worse = original.replace('throw new ToolError("bug", "flaky.get is broken", { hint: "the plugin has a bug" })', 'throw new Error("boom")').replace("const BROKEN = true;", "const BROKEN = 1;");
    const p = await sinty.patches.propose(s.id, { plugin: "flaky", reason: "make it worse", files: [{ path: "index.js", content: worse }] });
    assert.equal(p.status, "ready");
    const r = await sinty.patches.apply(p.id);
    assert.equal(r.applied, true);
    assert.match(readFileSync(join(home, "plugins", "flaky", "index.js"), "utf8"), /boom/);

    await sinty.patches.observe("flaky", { ok: false, code: "plugin_error" });
    await sinty.patches.observe("flaky", { ok: false, code: "plugin_error" });
    assert.equal(sinty.patches.getPatch(p.id)?.status, "rolled_back");
    assert.equal(readFileSync(join(home, "plugins", "flaky", "index.js"), "utf8"), original);
    assert.ok(types(sinty.journal.events(s.id)).includes("plugin.patch.rolled_back"));
    assert.ok(sinty.host.toolOwner("flaky.get"), "the plugin runs again after rollback");
  } finally {
    await sinty.stop();
    cleanup();
  }
});
