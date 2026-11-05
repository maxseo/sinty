import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generationMedia, openGenerationFile } from "../media-file.js";

test("a generation result keeps only media saved under _out/generation", () => {
  const root = mkdtempSync(join(tmpdir(), "sinty-media-"));
  const dir = join(root, "_out", "generation", "task1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "0.mp3"), "audio");
  writeFileSync(join(dir, "1.png"), "image");
  const files = generationMedia(root, {
    files: [join(dir, "0.mp3"), "_out/generation/task1/1.png", "_out/runninghub/old.mp4", "https://cdn.example/a.mp4"],
    note: "../secrets.json",
  });
  assert.deepEqual(files, [
    { path: "_out/generation/task1/0.mp3", kind: "audio" },
    { path: "_out/generation/task1/1.png", kind: "image" },
  ]);
  assert.equal(openGenerationFile(root, "_out/generation/task1/0.mp3")?.type, "audio/mpeg");
  assert.equal(openGenerationFile(root, "_out/generation/task1/../../../secrets.json"), undefined);
  assert.equal(openGenerationFile(root, "_inbox/photo.png"), undefined);
});
