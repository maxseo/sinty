import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runShell } from "../shell.js";

test("shell stays in the workspace and returns stdout", async () => {
  const root = mkdtempSync(join(tmpdir(), "sinty-sh-"));
  const ok = await runShell(root, `node -e "console.log('ok')"`);
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /ok/);
  await assert.rejects(() => runShell(root, "node -e 1", ".."));
});
