import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlToMarkdown, isShownUrl } from "./page.ts";

test("page becomes markdown and private hosts are refused", () => {
  const doc = htmlToMarkdown(`<html><head><title>Tea</title></head><body><h1>Brew</h1><p>See <a href="/cup">the cup</a> and <a href="http://127.0.0.1/x">local</a>.</p><script>alert(1)</script></body></html>`, "https://example.com/tea");
  assert.equal(doc.title, "Tea");
  assert.match(doc.markdown, /# Brew/);
  assert.match(doc.markdown, /\[the cup\]\(https:\/\/example.com\/cup\)/);
  assert.equal(doc.links.length, 1);
  assert.doesNotMatch(doc.markdown, /alert/);
  assert.equal(isShownUrl("http://127.0.0.1/secret"), false);
  assert.equal(isShownUrl("http://169.254.169.254/"), false);
  assert.equal(isShownUrl("file:///c:/windows"), false);
  assert.equal(isShownUrl("http://[::ffff:127.0.0.1]/"), false);
  assert.equal(isShownUrl("http://printer.local/"), false);
  assert.equal(isShownUrl("https://example.com/"), true);
});

test("limits cut text and links", () => {
  const links = Array.from({ length: 10 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join(" ");
  const doc = htmlToMarkdown(`<p>${"x".repeat(5000)}</p>${links}`, "https://example.com/", { maxChars: 1000, maxLinks: 3 });
  assert.equal(doc.links.length, 3);
  assert.match(doc.markdown, /…\[truncated\]$/);
});
