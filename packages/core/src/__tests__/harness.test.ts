import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { policySchema } from "../config.js";
import { pathVerdict } from "../policy.js";
import { assertSandbox, runShell } from "../shell.js";
import { boot, tempHome } from "./helpers.js";
import { setTimeout as sleep } from "node:timers/promises";

// TODO(sandbox): the shell cage (Windows paths, AppContainer-style isolation) is Windows-only today.
// Port these two tests when the Linux sandbox lands; until then they are skipped off Windows.
const windowsOnly = process.platform !== "win32" ? "the shell sandbox is Windows-only (TODO: Linux sandbox)" : false;

const allowAll = policySchema.parse({ defaults: { none: "allow", read: "allow", write: "allow", external: "allow" } });

test("a secret file asks even when the write tool is allowed", () => {
  const v = pathVerdict(allowAll, "E:/work", "write", "E:/work/secrets.json");
  assert.equal(v?.decision, "ask");
  assert.equal(pathVerdict(allowAll, "E:/work", "write", "E:/work/notes.txt"), undefined);
});

test("a command that leaves the workspace is refused before it starts", { skip: windowsOnly }, () => {
  assert.throws(() => assertSandbox("E:/work", "E:/work", "type ..\\..\\.sinty\\secret.key"), /outside the workspace/);
  assert.doesNotThrow(() => assertSandbox("E:/work", "E:/work", "npm test"));
});

test("a command cannot read a file outside its workspace", { skip: windowsOnly }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "sinty-cage-ws-"));
  const outside = mkdtempSync(join(tmpdir(), "sinty-cage-out-"));
  writeFileSync(join(ws, "ok.txt"), "inside");
  writeFileSync(join(outside, "secret.txt"), "CAGE-SECRET-MARKER");
  writeFileSync(
    join(ws, "read.js"),
    "const fs=require('fs');const os=require('os');const path=require('path');let outside='blocked';try{const dir=fs.readdirSync(os.tmpdir()).find(n=>n.startsWith('sinty-cage-out-'));outside=fs.readFileSync(path.join(os.tmpdir(),dir,'secret.txt'),'utf8')}catch(e){outside='blocked'}console.log('inside '+String(outside).trim())",
  );
  const result = await runShell(ws, "node read.js");
  assert.match(result.stdout, /inside/);
  assert.equal(result.stdout.includes("CAGE-SECRET-MARKER"), false);
});

test("reads in one model step run together", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(
    home,
    [{ toolCalls: [{ name: "sleep__long", args: { ms: 300 } }, { name: "sleep__long", args: { ms: 300 } }] }, { text: "done" }],
    { policy: allowAll },
  );
  try {
    const started = Date.now();
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "both");
    await sinty.agent.idle();
    assert.ok(Date.now() - started < 550);
    assert.equal(sinty.journal.events(s.id).filter((e) => e.type === "tool.call.completed").length, 2);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("a child turn cannot use tools outside its list", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(
    home,
    [
      { toolCalls: [{ name: "agent.task", args: { task: "look", tools: ["memory.recall"] } }] },
      { text: "parent done" },
    ],
    { policy: allowAll },
  );
  try {
    const s = sinty.agent.createSession();
    sinty.agent.send(s.id, "go");
    await sinty.agent.idle();
    const events = sinty.journal.events(s.id);
    const done = events.find((e) => e.type === "tool.call.completed");
    const result = (done?.data as { result?: { text?: string } }).result;
    assert.match(result?.text ?? "", /parent done|Дочерний|child|fallthrough|denied/i);
    await sleep(1);
  } finally {
    await sinty.stop();
    cleanup();
  }
});
