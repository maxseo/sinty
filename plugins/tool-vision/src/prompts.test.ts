import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt } from "./prompts.ts";

test("buildPrompt modes include instructions", () => {
  assert.match(buildPrompt("describe"), /Describe the image/);
  assert.match(buildPrompt("ocr"), /Extract all readable text/);
  assert.match(buildPrompt("find", "red button"), /red button/);
  assert.match(buildPrompt("describe", "focus on table"), /focus on table/);
});
