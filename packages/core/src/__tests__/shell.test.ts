import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runShell, shellGrants, assertSandbox } from "../shell.js";

test("a folder outside the project is listed for approval, and the profile is not", () => {
  if (process.platform !== "win32") return;
  const env = { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", USERPROFILE: "C:\\Users\\a" };
  const home = "C:\\Users\\a\\.sinty";
  const grants = shellGrants("C:\\work", "C:\\work", 'dir "%LOCALAPPDATA%\\Sinty\\tools\\ffmpeg\\bin"', env, home);
  assert.deepEqual(grants, ["C:\\Users\\a\\AppData\\Local\\Sinty\\tools\\ffmpeg\\bin"]);
  assert.doesNotThrow(() => assertSandbox("C:\\work", "C:\\work", 'dir "%LOCALAPPDATA%\\Sinty\\tools\\ffmpeg\\bin"', grants, env, home));
  assert.throws(() => assertSandbox("C:\\work", "C:\\work", 'dir "%LOCALAPPDATA%\\Sinty\\tools\\ffmpeg\\bin"', [], env, home), /outside the workspace/);
  assert.throws(() => shellGrants("C:\\work", "C:\\work", 'dir "%USERPROFILE%"', env, home), /too wide/);
  assert.throws(() => shellGrants("C:\\work", "C:\\work", 'type "C:\\Users\\a\\.sinty\\secret.key"', env, home), /never granted/);
  assert.throws(() => shellGrants("C:\\work", "C:\\work", "dir C:\\", env, home), /too wide/);
  assert.throws(() => assertSandbox("C:\\work", "C:\\work", 'dir "C:\\other\\bin"', ["C:\\allowed"], env, home), /outside the workspace/);
});

test("shell stays in the workspace and returns stdout", async () => {
  const root = mkdtempSync(join(tmpdir(), "sinty-sh-"));
  const ok = await runShell(root, `node -e "console.log('ok')"`);
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /ok/);
  await assert.rejects(() => runShell(root, "node -e 1", ".."));
});

test("an approved folder can be read and the timeout kills the command", async () => {
  if (process.platform !== "win32") return;
  const ws = mkdtempSync(join(tmpdir(), "sinty-sh-ws-"));
  const allow = mkdtempSync(join(tmpdir(), "sinty-sh-allow-"));
  writeFileSync(join(allow, "note.txt"), "GRANT-MARKER");
  await assert.rejects(() => runShell(ws, `type "${join(allow, "note.txt")}"`));
  const opened = await runShell(ws, `type "${join(allow, "note.txt")}"`, ".", 30_000, { grants: [allow] });
  assert.match(opened.stdout, /GRANT-MARKER/);
  const hung = await runShell(ws, `node -e "setTimeout(()=>{}, 60000)"`, ".", 1_500);
  assert.equal(hung.timedOut, true);
});
