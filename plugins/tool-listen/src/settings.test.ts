import assert from "node:assert/strict";
import { test } from "node:test";
import { readSettings } from "./settings.ts";

test("listen settings: defaults and a trimmed route", () => {
  assert.equal(readSettings({}).modelRoute, "");
  assert.equal(readSettings({}).maxSeconds, 600);
  assert.equal(readSettings({ modelRoute: " openrouter/google/gemini-2.5-flash ", maxMinutes: 3 }).modelRoute, "openrouter/google/gemini-2.5-flash");
  assert.equal(readSettings({ maxMinutes: 99 }).maxSeconds, 1800);
});
