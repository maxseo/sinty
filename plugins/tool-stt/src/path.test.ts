import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ToolError } from "@sinty/sdk";
import { resolveAudioPath } from "./path.ts";

test("resolveAudioPath: relative under workspace and skills, escape refused", () => {
  const workspace = mkdtempSync(join(tmpdir(), "sinty-stt-ws-"));
  const skills = mkdtempSync(join(tmpdir(), "sinty-stt-sk-"));
  const hit = resolveAudioPath("_inbox/voice.mp3", { workspace, skills });
  assert.equal(hit.shown, "_inbox/voice.mp3");
  assert.ok(hit.abs.startsWith(workspace));
  assert.equal(resolveAudioPath("skills:stt/ref.wav", { workspace, skills }).shown, "skills:stt/ref.wav");
  assert.throws(
    () => resolveAudioPath("../secret.mp3", { workspace, skills }),
    (e: unknown) => e instanceof ToolError && e.code === "outside_workspace",
  );
});
