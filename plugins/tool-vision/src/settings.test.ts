import assert from "node:assert/strict";
import { test } from "node:test";
import { readSettings } from "./settings.ts";

test("readSettings defaults and clamps", () => {
  const s = readSettings({});
  assert.equal(s.modelRoute, "");
  assert.equal(s.maxBytes, 8_000_000);
  assert.equal(s.maxOutputTokens, 1200);
  const c = readSettings({ modelRoute: "  vision  ", maxImageMb: 99, maxOutputTokens: 50 });
  assert.equal(c.modelRoute, "vision");
  assert.equal(c.maxBytes, 8_000_000);
  assert.equal(c.maxOutputTokens, 100);
});
