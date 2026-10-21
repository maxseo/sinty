import assert from "node:assert/strict";
import { test } from "node:test";
import { readSettings, safeSubdir } from "./settings.ts";

test("defaults match the old core limits", () => {
  const s = readSettings({});
  assert.equal(s.searchEngine, "duckduckgo");
  assert.equal(s.maxResults, 8);
  assert.equal(s.timeoutMs, 20_000);
  assert.equal(s.maxBytes, 1_500_000);
  assert.equal(s.maxChars, 20_000);
  assert.equal(s.maxLinks, 40);
  assert.equal(s.browserTimeoutMs, 20_000);
  assert.equal(s.actionTimeoutMs, 8_000);
  assert.equal(s.screenshotDir, "browser");
  assert.equal(s.userAgent, "Sinty/1.0");
});

test("values are clamped and the screenshot folder stays in the workspace", () => {
  const s = readSettings({ maxResults: 99, timeoutSeconds: "5", maxPageKb: 1, searchEngine: "searxng" });
  assert.equal(s.maxResults, 20);
  assert.equal(s.timeoutMs, 5000);
  assert.equal(s.maxBytes, 50_000);
  assert.equal(s.searchEngine, "searxng");
  for (const bad of ["../x", "/etc", "C:\\\\x", "a/../../b", ".", ""]) assert.equal(safeSubdir(bad), "browser", bad);
  assert.equal(safeSubdir("shots/web"), "shots/web");
});
