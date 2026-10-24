import assert from "node:assert/strict";
import { test } from "node:test";
import { readSettings } from "./settings.ts";

test("readSettings: showDisabled defaults true; false only when explicitly false", () => {
  assert.equal(readSettings({}).showDisabled, true);
  assert.equal(readSettings({ showDisabled: true }).showDisabled, true);
  assert.equal(readSettings({ showDisabled: false }).showDisabled, false);
  assert.equal(readSettings({ showDisabled: "no" }).showDisabled, true);
});
