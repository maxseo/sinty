import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compositionMeta, inlineAssets, insideDir, listSlugs } from "./gallery.js";

test("composition meta reads the stage attributes", () => {
  const html = '<title>Ignored</title><div data-composition-id="neon-loop" data-width="1920" data-height="1080"></div>';
  assert.deepEqual(compositionMeta(html), { id: "neon-loop", title: "Ignored", width: 1920, height: 1080 });
});

test("a path outside the folder is rejected", () => {
  const root = join(tmpdir(), "hf-root");
  assert.equal(insideDir(root, join(root, "neon-loop")), true);
  assert.equal(insideDir(root, join(root, "..", "secrets")), false);
});

test("list keeps only slug folders that have index.html", () => {
  const workspace = mkdtempSync(join(tmpdir(), "hf-ws-"));
  const root = join(workspace, "hyperframes");
  mkdirSync(join(root, "neon-loop"), { recursive: true });
  writeFileSync(join(root, "neon-loop", "index.html"), "<title>Neon</title>");
  mkdirSync(join(root, "Not A Slug"), { recursive: true });
  writeFileSync(join(root, "Not A Slug", "index.html"), "");
  mkdirSync(join(root, "empty-one"), { recursive: true });
  assert.deepEqual(listSlugs(workspace), ["neon-loop"]);
});

test("relative images become data urls and outside paths stay", () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-html-"));
  writeFileSync(join(dir, "cat.png"), Buffer.from("png"));
  const html = '<img src="cat.png"><img src="../secret.png"><img src="https://example.com/a.png">';
  const out = inlineAssets(dir, html);
  assert.match(out, /src="data:image\/png;base64,/);
  assert.match(out, /src="\.\.\/secret\.png"/);
  assert.match(out, /src="https:\/\/example\.com\/a\.png"/);
});
