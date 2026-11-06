import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fileInRoot } from "./paths.ts";

const project = join("/tmp", "workspace", "projects", "demo");

test("a project-relative inbox file stays in the session root", () => {
  assert.equal(fileInRoot(project, "_inbox/cat.png"), join(project, "_inbox", "cat.png"));
});

test("a path that leaves the session root is refused", () => {
  assert.equal(fileInRoot(project, "../other/_inbox/secret.png"), undefined);
  assert.equal(fileInRoot(project, "/home/max/.sinty/secrets.json"), undefined);
});
