import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { CHILD_PROCESS_WARNING_OFF, CHILD_PROCESS_WARNING_OFF_LEGACY, childProcessWarningFlag } from "../host/host.js";
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
    assert.ok(args.includes(childProcessWarningFlag()));
    const plain = sinty.host.plugins.get("fake-provider")!.permissionArgs();
    assert.ok(!plain.includes("--allow-child-process"));
    assert.ok(!plain.some((a) => a.startsWith("--disable-warning=") && a !== "--disable-warning=ExperimentalWarning"), "no warning is switched off for plugins without child processes");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("only the --allow-child-process warning is switched off; other warnings still print", () => {
  const flag = childProcessWarningFlag();
  const run = (code: string) =>
    spawnSync(process.execPath, ["--permission", "--allow-child-process", flag, "-e", code], { encoding: "utf8" }).stderr;
  assert.doesNotMatch(run("1"), /PERM0002|SecurityWarning/);
  assert.match(run("process.emitWarning('dep', { type: 'DeprecationWarning', code: 'DEP9999' })"), /DEP9999/);
  const other = run("process.emitWarning('other', { type: 'SecurityWarning', code: 'TEST0001' })");
  if (flag === CHILD_PROCESS_WARNING_OFF) assert.match(other, /\[TEST0001\] SecurityWarning: other/);
  else {
    // This Node prints the warning without a code: the type is switched off in this process only.
    assert.equal(flag, CHILD_PROCESS_WARNING_OFF_LEGACY);
    assert.doesNotMatch(other, /TEST0001/);
  }
});
