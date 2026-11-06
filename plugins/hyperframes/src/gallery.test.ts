import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compositionDir, compositionMeta, compositionWriteRoot, inlineAssets, insideDir, listSlugs, listSlugsAcross, listWorkspaceRoots } from "./gallery.js";

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

test("new writes go under the session workspace, and without one they stay global", () => {
  assert.equal(compositionWriteRoot("/tmp/projects/demo", "/tmp/global"), join("/tmp/projects/demo", "hyperframes"));
  assert.equal(compositionWriteRoot(undefined, "/tmp/global"), join("/tmp/global", "hyperframes"));
});

test("render prefers a session composition and falls back to a leftover global one", () => {
  const global = mkdtempSync(join(tmpdir(), "hf-global-"));
  const session = mkdtempSync(join(tmpdir(), "hf-session-"));
  mkdirSync(join(global, "hyperframes", "old-one"), { recursive: true });
  writeFileSync(join(global, "hyperframes", "old-one", "index.html"), "<title>Old</title>");
  assert.equal(compositionDir("old-one", session, global), join(global, "hyperframes", "old-one"));
  mkdirSync(join(session, "hyperframes", "old-one"), { recursive: true });
  writeFileSync(join(session, "hyperframes", "old-one", "index.html"), "<title>New</title>");
  assert.equal(compositionDir("old-one", session, global), join(session, "hyperframes", "old-one"));
  assert.equal(compositionDir("brand-new", session, global), join(session, "hyperframes", "brand-new"));
});

test("the tab lists compositions from the global workspace and from project folders", () => {
  const global = mkdtempSync(join(tmpdir(), "hf-lib-"));
  mkdirSync(join(global, "hyperframes", "global-loop"), { recursive: true });
  writeFileSync(join(global, "hyperframes", "global-loop", "index.html"), "<title>G</title>");
  mkdirSync(join(global, "projects", "demo", "hyperframes", "project-loop"), { recursive: true });
  writeFileSync(join(global, "projects", "demo", "hyperframes", "project-loop", "index.html"), "<title>P</title>");
  assert.deepEqual(listWorkspaceRoots(global).slice(1), [join(global, "projects", "demo")]);
  assert.deepEqual(listSlugsAcross(listWorkspaceRoots(global)), ["global-loop", "project-loop"]);
});
