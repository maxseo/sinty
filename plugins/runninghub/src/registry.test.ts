import assert from "node:assert/strict";
import test from "node:test";
import { isTerminal, outputsOf } from "./client.js";
import { SEED, searchModels, validatePayload } from "./registry.js";

test("search finds a text-to-image model and skips the other kind", () => {
  const images = searchModels(SEED, "nano banana", "image");
  assert.equal(images.length, 2);
  const video = searchModels(SEED, "nano", "video");
  assert.equal(video.length, 0);
});

test("validate refuses an unknown field and a value outside the list", () => {
  const model = SEED.models[0]!;
  const bad = validatePayload(model, { prompt: "cat", aspectRatio: "2:1", extra: 1 });
  assert.deepEqual(bad.map((e) => e.field).sort(), ["aspectRatio", "extra"]);
  assert.equal(validatePayload(model, { prompt: "cat", aspectRatio: "1:1" }).length, 0);
});

test("a finished task exposes result urls and SUCCESS is terminal", () => {
  assert.equal(isTerminal("RUNNING"), false);
  assert.equal(isTerminal("SUCCESS"), true);
  assert.deepEqual(outputsOf({ status: "SUCCESS", results: [{ url: "https://cdn.example/a.png", outputType: "image" }] }), [{ url: "https://cdn.example/a.png", outputType: "image" }]);
});
