import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ToolError } from "@sinty/sdk";
import { resolveFsPath } from "./index.js";

test("resolveFsPath: relative paths use the given workspace root (project chroot)", () => {
  const root = mkdtempSync(join(tmpdir(), "sinty-fs-"));
  try {
    const globalWs = join(root, "workspace");
    const project = join(globalWs, "projects", "demo");
    const skills = join(root, "skills");
    mkdirSync(join(project, "_out"), { recursive: true });
    mkdirSync(skills, { recursive: true });
    writeFileSync(join(project, "_out", "a.txt"), "hi");

    const hit = resolveFsPath("_out/a.txt", { workspace: project, skills });
    assert.equal(hit.abs, join(project, "_out", "a.txt"));
    assert.equal(hit.shown, "_out/a.txt");

    const globalHit = resolveFsPath("_out/a.txt", { workspace: globalWs, skills });
    assert.equal(globalHit.abs, join(globalWs, "_out", "a.txt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveFsPath: project chroot cannot escape into the parent workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "sinty-fs-"));
  try {
    const globalWs = join(root, "workspace");
    const project = join(globalWs, "projects", "demo");
    const skills = join(root, "skills");
    mkdirSync(project, { recursive: true });
    mkdirSync(skills, { recursive: true });
    writeFileSync(join(globalWs, "secret.txt"), "nope");

    assert.throws(
      () => resolveFsPath("../secret.txt", { workspace: project, skills }),
      (e: unknown) => e instanceof ToolError && e.code === "outside_workspace",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveFsPath: skills: prefix still resolves against skills", () => {
  const root = mkdtempSync(join(tmpdir(), "sinty-fs-"));
  try {
    const workspace = join(root, "projects", "demo");
    const skills = join(root, "skills");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(skills, "demo"), { recursive: true });
    writeFileSync(join(skills, "demo", "SKILL.md"), "# x");
    const hit = resolveFsPath("skills:demo/SKILL.md", { workspace, skills });
    assert.equal(hit.abs, join(skills, "demo", "SKILL.md"));
    assert.equal(hit.shown, "skills:demo/SKILL.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
