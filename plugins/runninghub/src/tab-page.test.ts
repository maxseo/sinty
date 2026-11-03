import assert from "node:assert/strict";
import test from "node:test";
import { tabHtml } from "./tab-page.js";

test("the catalog script parses", () => {
  const html = tabHtml();
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (typeof script !== "string") throw new Error("catalog page has no script");
  assert.doesNotThrow(() => new Function(script));
});
