import assert from "node:assert/strict";
import { test } from "node:test";
import { readSettings } from "./settings.ts";

test("readSettings defaults and clamps", () => {
  const s = readSettings({});
  assert.equal(s.modelRoute, "");
  assert.equal(s.maxBytes, 8_000_000);
  assert.equal(s.reasoning, false);
  assert.equal(s.batch, 4);
  const c = readSettings({ modelRoute: "  vision  ", maxImageMb: 99, reasoning: true });
  assert.equal(c.modelRoute, "vision");
  assert.equal(c.maxBytes, 8_000_000);
  assert.equal(c.reasoning, true);
  assert.equal(readSettings({ batch: 0 }).batch, 1);
  assert.equal(readSettings({ batch: 99 }).batch, 16);
});
