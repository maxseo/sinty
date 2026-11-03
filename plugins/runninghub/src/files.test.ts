import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { fileInRoot } from "./files.js";

const root = join("C:\\work", "проект");

test("a project-relative inbox file stays in the project", () => {
  assert.equal(fileInRoot(root, "_inbox/голос.mp3"), join(root, "_inbox", "голос.mp3"));
});

test("a path that leaves the project is refused", () => {
  assert.equal(fileInRoot(root, "../secrets.json"), undefined);
  assert.equal(fileInRoot(root, "C:\\Users\\Maxseo\\.sinty\\secrets.json"), undefined);
});
