import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicHttp, htmlToMarkdown } from "../web.js";

test("page becomes markdown and private hosts are refused", () => {
  const doc = htmlToMarkdown(`<html><head><title>Tea</title></head><body><h1>Brew</h1><p>See <a href="/cup">the cup</a> and <a href="http://127.0.0.1/x">local</a>.</p><script>alert(1)</script></body></html>`, "https://example.com/tea");
  assert.equal(doc.title, "Tea");
  assert.match(doc.markdown, /# Brew/);
  assert.match(doc.markdown, /\[the cup\]\(https:\/\/example.com\/cup\)/);
  assert.equal(doc.links.length, 1);
  assert.doesNotMatch(doc.markdown, /alert/);
  assert.throws(() => assertPublicHttp("http://127.0.0.1/secret"));
  assert.throws(() => assertPublicHttp("http://169.254.169.254/"));
  assert.throws(() => assertPublicHttp("file:///c:/windows"));
});
