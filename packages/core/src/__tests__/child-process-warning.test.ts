import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { CHILD_PROCESS_WARNING_OFF } from "../host/host.js";
import { Sinty } from "../sinty.js";
import { tempHome, testConfig } from "./helpers.js";

test("tool-web starts without Node's --allow-child-process SecurityWarning; the host says it once as info", async () => {
  const { home, cleanup } = tempHome();
  const lines: { level: string; msg: string }[] = [];
  const sinty = new Sinty({ home, config: testConfig([], {}, ["fake-provider", "tool-web"]), log: (level, msg) => lines.push({ level, msg }) });
  try {
    const { failedPlugins } = await sinty.start();
    assert.deepEqual(failedPlugins, []);
    const web = sinty.host.plugins.get("tool-web")!;
    // Node prints startup warnings before the runner's ready; a short wait catches a late stderr chunk too.
    await new Promise((r) => setTimeout(r, 300));
    const fromWeb = lines.filter((l) => l.msg.startsWith("[tool-web]"));
    assert.equal(fromWeb.filter((l) => /SecurityWarning|PERM0002|allow-child-process must be used/.test(l.msg)).length, 0, JSON.stringify(fromWeb));
    assert.equal(fromWeb.filter((l) => l.level === "warn").length, 0, JSON.stringify(fromWeb));
    assert.equal(fromWeb.filter((l) => l.level === "info" && /may start child processes \(permissions\.browser\)/.test(l.msg)).length, 1);

    const args = web.permissionArgs();
    assert.ok(args.includes("--allow-child-process"));
    assert.ok(args.includes(CHILD_PROCESS_WARNING_OFF));
    const plain = sinty.host.plugins.get("fake-provider")!.permissionArgs();
    assert.ok(!plain.includes("--allow-child-process"));
    assert.ok(!plain.includes(CHILD_PROCESS_WARNING_OFF), "no warning is switched off for plugins without child processes");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("only PERM0002 is switched off: other SecurityWarnings still print", () => {
  const run = (code: string) =>
    spawnSync(process.execPath, ["--permission", "--allow-child-process", CHILD_PROCESS_WARNING_OFF, "-e", code], { encoding: "utf8" }).stderr;
  assert.doesNotMatch(run("1"), /PERM0002|SecurityWarning/);
  assert.match(run("process.emitWarning('other', { type: 'SecurityWarning', code: 'TEST0001' })"), /\[TEST0001\] SecurityWarning: other/);
  assert.match(run("process.emitWarning('dep', { type: 'DeprecationWarning', code: 'DEP9999' })"), /DEP9999/);
});
