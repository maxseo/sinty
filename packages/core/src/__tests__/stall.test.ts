import assert from "node:assert/strict";
import { test } from "node:test";
import { watchStall } from "../stall.js";

test("stall warns once and then escalates", async () => {
  const seen: string[] = [];
  const watch = watchStall(
    0.05,
    () => seen.push("notice"),
    () => seen.push("escalate"),
  );
  await new Promise((r) => setTimeout(r, 180));
  watch.stop();
  assert.deepEqual(seen, ["notice", "escalate"]);
});
