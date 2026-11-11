import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "./index.ts";

test("rhany plugin loads", () => {
  assert.equal(typeof plugin, "object");
  assert.equal(typeof (plugin as any).setup, "function");
});
