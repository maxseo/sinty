import assert from "node:assert/strict";
import test from "node:test";
import { isTerminal, outputsOf } from "./client.js";
import { parseRegistry, SEED, searchModels, validatePayload } from "./registry.js";

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

test("the public registry shape keeps the endpoint, the display name and list values", () => {
  const parsed = parseRegistry({
    version: "public",
    models: [{
      class_name: "Hitem3dPortraitV15ImageTo3d",
      display_name: "RH hitem3d-portrait-v15/image-to-3d",
      endpoint: "hitem3d-portrait-v15/image-to-3d",
      output_type: "3d",
      params: [{ fieldKey: "requestType", type: "LIST", required: true, defaultValue: "mesh", options: [{ value: "mesh" }, { value: "both" }] }],
    }],
  });
  assert.equal(parsed.models.length, 1);
  assert.equal(parsed.models[0]?.name_en, "RH hitem3d-portrait-v15/image-to-3d");
  assert.deepEqual(parsed.models[0]?.params?.[0]?.options, ["mesh", "both"]);
  assert.equal(validatePayload(parsed.models[0]!, { requestType: "mesh" }).length, 0);
});

test("a finished task exposes result urls and SUCCESS is terminal", () => {
  assert.equal(isTerminal("RUNNING"), false);
  assert.equal(isTerminal("SUCCESS"), true);
  assert.deepEqual(outputsOf({ status: "SUCCESS", results: [{ url: "https://cdn.example/a.png", outputType: "image" }] }), [{ url: "https://cdn.example/a.png", outputType: "image" }]);
});
