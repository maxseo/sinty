import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown, safeHref, type MdNode } from "./md.ts";

function tags(nodes: MdNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.kind === "el") {
      out.push(node.tag);
      out.push(...tags(node.children));
    } else if (node.kind === "a") {
      out.push("a");
      out.push(...tags(node.children));
    } else if (node.kind === "text") out.push(`t:${node.text}`);
    else out.push(node.kind);
  }
  return out;
}

test("headings, lists and a table become elements", () => {
  const src = [
    "# Модели",
    "",
    "- поиск",
    "- запуск",
    "",
    "| Имя | Цена |",
    "| --- | ---: |",
    "| Кот | 10 |",
  ].join("\n");
  const tree = tags(parseMarkdown(src));
  assert.deepEqual(tree.filter((t) => !t.startsWith("t:")), ["h1", "ul", "li", "li", "table", "thead", "tr", "th", "th", "tbody", "tr", "td", "td"]);
  assert.equal(tree.includes("t:Модели"), true);
  assert.equal(tree.includes("t:Кот"), true);
});

test("a web link stays a link and a script url becomes text", () => {
  const ok = parseMarkdown("[каталог](https://example.com/models)");
  assert.equal(ok[0]?.kind, "el");
  const link = ok[0]?.kind === "el" ? ok[0].children[0] : undefined;
  assert.equal(link?.kind, "a");
  if (link?.kind === "a") assert.equal(link.href, "https://example.com/models");

  const bad = tags(parseMarkdown("[x](javascript:alert(1))"));
  assert.equal(bad.includes("a"), false);
  assert.equal(bad.includes("t:x"), true);
});

test("safeHref allows web and mail addresses only", () => {
  assert.equal(safeHref("https://example.com/a"), "https://example.com/a");
  assert.equal(safeHref("mailto:a@example.com"), "mailto:a@example.com");
  assert.equal(safeHref("/settings"), "/settings");
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,hi"), null);
  assert.equal(safeHref("//evil.example"), null);
});
