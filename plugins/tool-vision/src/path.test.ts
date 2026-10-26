import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ToolError } from "@sinty/sdk";
import { resolveImagePath } from "./path.ts";

test("resolveImagePath: relative under workspace", () => {
  const workspace = mkdtempSync(join(tmpdir(), "sinty-vision-ws-"));
  const skills = mkdtempSync(join(tmpdir(), "sinty-vision-sk-"));
  const hit = resolveImagePath("_inbox/shot.png", { workspace, skills });
  assert.equal(hit.shown, "_inbox/shot.png");
  assert.ok(hit.abs.startsWith(workspace));
});

test("resolveImagePath: skills: prefix", () => {
  const workspace = mkdtempSync(join(tmpdir(), "sinty-vision-ws-"));
  const skills = mkdtempSync(join(tmpdir(), "sinty-vision-sk-"));
  const hit = resolveImagePath("skills:vision-look/ref.png", { workspace, skills });
  assert.equal(hit.shown, "skills:vision-look/ref.png");
  assert.ok(hit.abs.startsWith(skills));
});

test("resolveImagePath: escape refused", () => {
  const workspace = mkdtempSync(join(tmpdir(), "sinty-vision-ws-"));
  const skills = mkdtempSync(join(tmpdir(), "sinty-vision-sk-"));
  assert.throws(
    () => resolveImagePath("../secret.png", { workspace, skills }),
    (e: unknown) => e instanceof ToolError && e.code === "outside_workspace",
  );
});
