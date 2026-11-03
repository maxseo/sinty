import assert from "node:assert/strict";
import test from "node:test";
import { mergeMedia, splitMedia } from "./media-ref.ts";

test("an agent message keeps the words and lifts the generated file", () => {
  const split = splitMedia("Готово.\n_out/generation/task/0.mp3\nhttps://cdn.example/clip.mp4");
  assert.equal(split.text, "Готово.");
  assert.deepEqual(split.files, [
    { path: "_out/generation/task/0.mp3", kind: "audio" },
    { path: "https://cdn.example/clip.mp4", kind: "video" },
  ]);
  assert.equal(mergeMedia(split.files, [{ path: "_out/generation/task/0.mp3", kind: "audio" }]).length, 2);
});
