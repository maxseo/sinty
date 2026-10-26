import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt } from "./prompts.ts";

test("buildPrompt modes include instructions", () => {
  assert.match(buildPrompt("describe"), /Describe the image/);
  assert.match(buildPrompt("ocr"), /Extract all readable text/);
  assert.match(buildPrompt("find", "red button"), /red button/);
  assert.match(buildPrompt("describe", "focus on table"), /focus on table/);
  const batch = buildPrompt("ocr", "keep the table", ["a.png", "b.png"]);
  assert.match(batch, /2 images/);
  assert.match(batch, /1\. a\.png/);
  assert.match(batch, /2\. b\.png/);
  assert.doesNotMatch(buildPrompt("ocr"), /Images, in order/);
});
