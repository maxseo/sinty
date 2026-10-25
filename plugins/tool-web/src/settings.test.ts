import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_USER_AGENT, DEFAULT_ACCEPT_LANGUAGE, readSettings, safeSubdir } from "./settings.ts";

test("defaults: the old core limits, a 5 MB page limit and a browser user agent", () => {
  const s = readSettings({});
  assert.equal(s.searchEngine, "duckduckgo");
  assert.equal(s.maxResults, 8);
  assert.equal(s.timeoutMs, 20_000);
  assert.equal(s.maxBytes, 5_000_000);
  assert.equal(s.maxFetchBytes, 20_000_000);
  assert.equal(s.maxChars, 20_000);
  assert.equal(s.maxLinks, 40);
  assert.equal(s.browserTimeoutMs, 20_000);
  assert.equal(s.actionTimeoutMs, 8_000);
  assert.equal(s.screenshotDir, "browser");
  assert.equal(s.userAgent, BROWSER_USER_AGENT);
  assert.match(s.userAgent, /^Mozilla\/5\.0 .*Chrome\//);
  assert.equal(s.acceptLanguage, DEFAULT_ACCEPT_LANGUAGE);
});

test("user agent: the old default Sinty/1.0 saved by older Settings pages means the browser one; a custom one is kept", () => {
  assert.equal(readSettings({ userAgent: "Sinty/1.0" }).userAgent, BROWSER_USER_AGENT);
  assert.equal(readSettings({ userAgent: "  " }).userAgent, BROWSER_USER_AGENT);
  assert.equal(readSettings({ userAgent: "MyBot/2" }).userAgent, "MyBot/2");
  assert.equal(readSettings({ userAgent: "a\r\nX-Injected: 1" }).userAgent, "a X-Injected: 1", "no header injection");
  assert.equal(readSettings({ acceptLanguage: "en" }).acceptLanguage, "en");
});

test("values are clamped and the screenshot folder stays in the workspace", () => {
  const s = readSettings({ maxResults: 99, timeoutSeconds: "5", maxPageKb: 1, maxFetchMb: 99, searchEngine: "searxng" });
  assert.equal(s.maxResults, 20);
  assert.equal(s.timeoutMs, 5000);
  assert.equal(s.maxBytes, 50_000);
  assert.equal(s.maxFetchBytes, 20_000_000);
  assert.equal(s.searchEngine, "searxng");
  for (const bad of ["../x", "/etc", "C:\\\\x", "a/../../b", ".", ""]) assert.equal(safeSubdir(bad), "browser", bad);
  assert.equal(safeSubdir("shots/web"), "shots/web");
});
