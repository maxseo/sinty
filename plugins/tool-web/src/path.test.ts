import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { ToolError } from "@sinty/sdk";
import { resolveDestPath } from "./path.ts";

const ROOT = process.platform === "win32" ? "C:\\sinty-fetch-test" : "/tmp/sinty-fetch-test";

test("resolveDestPath: relative paths use the given workspace (project chroot)", () => {
  const globalWs = join(ROOT, "workspace");
  const project = join(globalWs, "projects", "demo");

  const hit = resolveDestPath("_out/a.bin", project);
  assert.equal(hit.abs, join(project, "_out", "a.bin"));
  assert.equal(hit.shown, "_out/a.bin");

  const globalHit = resolveDestPath("_out/a.bin", globalWs);
  assert.equal(globalHit.abs, join(globalWs, "_out", "a.bin"));
});

test("resolveDestPath: project chroot cannot escape into the parent workspace", () => {
  const globalWs = join(ROOT, "workspace");
  const project = join(globalWs, "projects", "demo");

  assert.throws(
    () => resolveDestPath("../secret.txt", project),
    (e: unknown) => e instanceof ToolError && e.code === "outside_workspace",
  );
  assert.throws(
    () => resolveDestPath(join(globalWs, "secret.txt"), project),
    (e: unknown) => e instanceof ToolError && e.code === "outside_workspace",
  );
});

test("resolveDestPath: skills: prefix is refused", () => {
  const workspace = join(ROOT, "projects", "demo");
  assert.throws(
    () => resolveDestPath("skills:demo/x.bin", workspace),
    (e: unknown) => e instanceof ToolError && e.code === "outside_workspace",
  );
});
