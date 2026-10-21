import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDuckDuckGo, parseSearxng, searchUrl } from "./search.ts";

/** A trimmed html.duckduckgo.com result page. If DuckDuckGo changes its markup, update this fixture with the parser. */
const DDG = `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftea&amp;rut=abc">Green <b>tea</b> guide</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftea">How to brew &amp; serve <b>tea</b>.</a>
</div>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=http%3A%2F%2F127.0.0.1%2Fadmin">Local admin</a></h2>
  <a class="result__snippet" href="#">should be dropped</a>
</div>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="https://example.org/cups">Cups</a></h2>
  <a class="result__snippet" href="https://example.org/cups">All about cups</a>
</div>`;

test("duckduckgo results are unwrapped, decoded and private targets dropped", () => {
  const r = parseDuckDuckGo(DDG);
  assert.deepEqual(r, [
    { title: "Green tea guide", url: "https://example.com/tea", snippet: "How to brew & serve tea ." },
    { title: "Cups", url: "https://example.org/cups", snippet: "All about cups" },
  ]);
  assert.equal(parseDuckDuckGo(DDG, 1).length, 1);
});

test("searxng json results", () => {
  const body = JSON.stringify({ results: [{ title: "A", url: "https://a.example/", content: "first" }, { title: "L", url: "http://10.0.0.5/" }, { url: "https://b.example/x" }] });
  assert.deepEqual(parseSearxng(body), [
    { title: "A", url: "https://a.example/", snippet: "first" },
    { title: "https://b.example/x", url: "https://b.example/x", snippet: "" },
  ]);
  assert.throws(() => parseSearxng("<html>"), /json/i);
});

test("search urls", () => {
  assert.equal(searchUrl("duckduckgo", "green tea"), "https://html.duckduckgo.com/html/?q=green%20tea");
  assert.equal(searchUrl("searxng", "a&b", "http://127.0.0.1:8888/"), "http://127.0.0.1:8888/search?q=a%26b&format=json");
  assert.throws(() => searchUrl("searxng", "x", ""));
});
