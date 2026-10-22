import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runShell, ShellSandboxError } from "../shell.js";
import { bwrapArgs, decideSandbox, findBwrap, probeBwrap, resetSandboxProbe } from "../shell-sandbox.js";

const linux = process.platform === "linux";
const bwrap = linux ? findBwrap() : undefined;
const usable = Boolean(bwrap && probeBwrap(bwrap).ok);
const skip = !linux ? "Linux only" : !bwrap ? "bubblewrap (bwrap) is not installed" : !usable ? `bubblewrap cannot create namespaces here: ${probeBwrap(bwrap!).error}` : false;

/** A fake user account: home with a Sinty home and a secret, a workspace inside it, a folder next to it. */
function account() {
  const root = mkdtempSync(join(tmpdir(), "sinty-box-"));
  const userHome = join(root, "user");
  const sintyHome = join(userHome, ".sinty");
  const workspace = join(sintyHome, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(sintyHome, "secrets.json"), "TOP-SECRET-CONTENT");
  writeFileSync(join(userHome, "notes.txt"), "PRIVATE-NOTES");
  return { root, userHome, sintyHome, workspace, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("bubblewrap: the command works in the workspace and cannot read or write outside it", { skip }, async () => {
  const a = account();
  const saved = process.env.HOME;
  process.env.HOME = a.userHome;
  try {
    const opts = { home: a.sintyHome };
    const ok = await runShell(a.workspace, `echo hi > made.txt && node -e "console.log(require('fs').readFileSync('made.txt','utf8').trim())"`, ".", 30_000, opts);
    assert.equal(ok.exitCode, 0, ok.stderr);
    assert.equal(ok.stdout, "hi");
    assert.equal(readFileSync(join(a.workspace, "made.txt"), "utf8").trim(), "hi");

    const secret = await runShell(a.workspace, `cat ${join(a.sintyHome, "secrets.json")}; cat ${join(a.userHome, "notes.txt")}; ls ${a.userHome}`, ".", 30_000, opts);
    assert.doesNotMatch(secret.stdout, /TOP-SECRET|PRIVATE-NOTES|notes\.txt/);
    // Only the empty folders on the way to the workspace exist inside.
    assert.match(secret.stderr, /No such file or directory/);

    const write = await runShell(a.workspace, `echo x > ${join(a.root, "escaped.txt")}; echo x > /usr/escaped.txt; echo done`, ".", 30_000, opts);
    assert.match(write.stdout, /done/);
    assert.throws(() => readFileSync(join(a.root, "escaped.txt")));

    const sub = await runShell(a.workspace, "pwd && echo $HOME", "sub/dir", 30_000, opts);
    assert.equal(sub.stdout.split("\n")[0], join(a.workspace, "sub", "dir"));
    assert.equal(sub.stdout.split("\n")[1], a.workspace);
  } finally {
    process.env.HOME = saved;
    a.cleanup();
  }
});

test("bubblewrap: secrets in the environment stay out; passEnv adds names, never SINTY_SECRET_*", { skip }, async () => {
  const a = account();
  process.env.SINTY_SECRET_TEST_KEY = "env-secret-value";
  process.env.SOME_API_KEY = "api-key-value";
  process.env.MY_TOOL_SETTING = "visible-value";
  try {
    const r = await runShell(a.workspace, "env", ".", 30_000, { home: a.sintyHome, passEnv: ["MY_TOOL_SETTING", "SINTY_SECRET_TEST_KEY"] });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /env-secret-value|api-key-value/);
    assert.match(r.stdout, /MY_TOOL_SETTING=visible-value/);
    assert.match(r.stdout, /^PATH=/m);
  } finally {
    delete process.env.SINTY_SECRET_TEST_KEY;
    delete process.env.SOME_API_KEY;
    delete process.env.MY_TOOL_SETTING;
    a.cleanup();
  }
});

test("bubblewrap: no network by default; shell.network: true allows it", { skip }, async () => {
  const a = account();
  const server = createServer((_q, s) => s.end("pong")).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const fetchCmd = `node -e "fetch('http://127.0.0.1:${port}/').then(r=>r.text()).then(t=>console.log(t),e=>{console.log('NET-FAIL');process.exit(3)})"`;
  try {
    const off = await runShell(a.workspace, fetchCmd, ".", 30_000, { home: a.sintyHome });
    assert.match(off.stdout, /NET-FAIL/);
    const on = await runShell(a.workspace, fetchCmd, ".", 30_000, { home: a.sintyHome, network: true });
    assert.equal(on.stdout, "pong", on.stderr);
  } finally {
    server.close();
    a.cleanup();
  }
});

test("bubblewrap: a timeout kills the sandboxed command", { skip }, async () => {
  const a = account();
  try {
    const started = Date.now();
    const r = await runShell(a.workspace, "sleep 30", ".", 1_000, { home: a.sintyHome });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 10_000);
  } finally {
    a.cleanup();
  }
});

test("sandbox decision: off, missing bwrap (auto runs unsandboxed with one warning; bwrap and strict refuse)", { skip: linux ? false : "Linux only" }, async () => {
  assert.deepEqual(decideSandbox({ sandbox: "off" }), { kind: "none", reason: "shell.sandbox: off" });
  assert.equal(decideSandbox({}, false, "win32").kind, "none");
  const saved = process.env.SINTY_BWRAP;
  process.env.SINTY_BWRAP = "";
  resetSandboxProbe();
  const a = account();
  try {
    assert.equal(decideSandbox({}).kind, "none");
    assert.equal(decideSandbox({ sandbox: "bwrap" }).kind, "refuse");
    assert.equal(decideSandbox({}, true).kind, "refuse");
    const logs: string[] = [];
    const r = await runShell(a.workspace, "echo plain", ".", 30_000, { log: (_l, m) => logs.push(m) });
    assert.equal(r.stdout, "plain");
    await runShell(a.workspace, "echo plain", ".", 30_000, { log: (_l, m) => logs.push(m) });
    assert.ok(logs.filter((m) => /without a sandbox/.test(m)).length <= 1, "warned at most once per process");
    await assert.rejects(() => runShell(a.workspace, "echo x", ".", 30_000, { sandbox: "bwrap" }), (e: unknown) => e instanceof ShellSandboxError && /apt install bubblewrap/.test((e as Error).message));
    await assert.rejects(() => runShell(a.workspace, "echo x", ".", 30_000, { strict: true }), ShellSandboxError);
  } finally {
    if (saved === undefined) delete process.env.SINTY_BWRAP;
    else process.env.SINTY_BWRAP = saved;
    resetSandboxProbe();
    a.cleanup();
  }
});

test("bwrapArgs never binds the Sinty home, the user's home or an ancestor of the workspace", () => {
  const a = account();
  try {
    const args = bwrapArgs({
      workspace: a.workspace,
      cwd: a.workspace,
      command: "true",
      home: a.sintyHome,
      env: { PATH: [a.userHome, a.sintyHome, join(a.sintyHome, "bin"), a.root, "/usr/bin", "relative/bin"].join(":"), HOME: a.userHome, SINTY_SECRET_X: "s" },
    });
    const bound = args.flatMap((v, i) => (args[i - 1] === "--ro-bind" || args[i - 1] === "--bind" ? [v] : []));
    for (const p of [a.userHome, a.sintyHome, join(a.sintyHome, "bin"), a.root]) assert.ok(!bound.includes(p), `not bound: ${p}`);
    assert.ok(bound.includes(a.workspace));
    assert.ok(!args.includes("SINTY_SECRET_X"));
    assert.ok(args.includes("--unshare-all") && !args.includes("--share-net"));
    assert.deepEqual(args.slice(-4), ["--", "/bin/sh", "-c", "true"]);
  } finally {
    a.cleanup();
  }
});
