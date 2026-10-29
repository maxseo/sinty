import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readMark, updateAvailable, writeMark, type Remote } from "./updates.js";

const remote: Remote = { version: "1.2.0", sha: "abc", date: "", title: "fix" };

test("no mark is not an update", () => {
  assert.equal(updateAvailable(null, remote), false);
});

test("a different commit is an update", () => {
  assert.equal(updateAvailable({ version: "1.2.0", sha: "old" }, remote), true);
});

test("the same mark is not an update", () => {
  assert.equal(updateAvailable({ version: "1.2.0", sha: "abc" }, remote), false);
});

test("marks round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-"));
  writeMark(dir, { version: "1.0.0", sha: "def" });
  assert.deepEqual(readMark(dir), { version: "1.0.0", sha: "def" });
  rmSync(dir, { recursive: true });
});
