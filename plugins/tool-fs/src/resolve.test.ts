import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { ToolError } from "@sinty/sdk";
import { resolveFsPath } from "./resolve.ts";

/** Synthetic absolute roots — resolveFsPath only does path math, no I/O. */
const ROOT = process.platform === "win32" ? "C:\\sinty-fs-test" : "/tmp/sinty-fs-test";

test("resolveFsPath: relative paths use the given workspace root (project chroot)", () => {
  const globalWs = join(ROOT, "workspace");
  const project = join(globalWs, "projects", "demo");
  const skills = join(ROOT, "skills");

  const hit = resolveFsPath("_out/a.txt", { workspace: project, skills });
  assert.equal(hit.abs, join(project, "_out", "a.txt"));
  assert.equal(hit.shown, "_out/a.txt");

  const globalHit = resolveFsPath("_out/a.txt", { workspace: globalWs, skills });
  assert.equal(globalHit.abs, join(globalWs, "_out", "a.txt"));
});

test("resolveFsPath: project chroot cannot escape into the parent workspace", () => {
  const globalWs = join(ROOT, "workspace");
  const project = join(globalWs, "projects", "demo");
  const skills = join(ROOT, "skills");

  assert.throws(
    () => resolveFsPath("../secret.txt", { workspace: project, skills }),
    (e: unknown) => e instanceof ToolError && e.code === "outside_workspace",
  );
  assert.throws(
    () => resolveFsPath(join(globalWs, "secret.txt"), { workspace: project, skills }),
    (e: unknown) => e instanceof ToolError && e.code === "outside_workspace",
  );
});

test("resolveFsPath: skills: prefix still resolves against skills", () => {
  const workspace = join(ROOT, "projects", "demo");
  const skills = join(ROOT, "skills");
  const hit = resolveFsPath("skills:demo/SKILL.md", { workspace, skills });
  assert.equal(hit.abs, join(skills, "demo", "SKILL.md"));
  assert.equal(hit.shown, "skills:demo/SKILL.md");
});
