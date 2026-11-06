import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { compilerPackage, usableCompiler } from "./host.js";

function fakeCompiler(root: string): string {
  const dir = join(root, "compiler");
  mkdirSync(join(dir, "node_modules", "esbuild"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "diffusion-compiler-test" }), "utf8");
  writeFileSync(join(dir, "node_modules", "esbuild", "package.json"), JSON.stringify({ name: "esbuild", main: "index.js" }), "utf8");
  writeFileSync(join(dir, "node_modules", "esbuild", "index.js"), "module.exports = {};\n", "utf8");
  return join(dir, "package.json");
}

test("usableCompiler accepts a package that can resolve esbuild", () => {
  const root = mkdtempSync(join(tmpdir(), "diff-comp-ok-"));
  const pkg = fakeCompiler(root);
  assert.equal(usableCompiler(pkg), pkg);
});

test("usableCompiler skips a package.json that has no esbuild", () => {
  const root = mkdtempSync(join(tmpdir(), "diff-comp-miss-"));
  const pkg = join(root, "compiler", "package.json");
  mkdirSync(dirname(pkg), { recursive: true });
  writeFileSync(pkg, JSON.stringify({ name: "empty-compiler" }), "utf8");
  assert.equal(usableCompiler(pkg), null);
  assert.equal(usableCompiler(join(root, "missing", "package.json")), null);
});

test("compilerPackage prefers cwd/compiler when that package can load esbuild", () => {
  const cwd = mkdtempSync(join(tmpdir(), "diff-cwd-"));
  const here = mkdtempSync(join(tmpdir(), "diff-here-"));
  const pkg = fakeCompiler(cwd);
  assert.equal(compilerPackage({ cwd, here, repair: false }), pkg);
});

test("compilerPackage finds compiler next to the plugin file when cwd has none", () => {
  const plugin = mkdtempSync(join(tmpdir(), "diff-plugin-"));
  const pkg = fakeCompiler(plugin);
  const here = join(plugin, "dist");
  mkdirSync(here, { recursive: true });
  const cwd = mkdtempSync(join(tmpdir(), "diff-empty-cwd-"));
  assert.equal(compilerPackage({ cwd, here, repair: false }), pkg);
});

test("compilerPackage skips a broken note and uses another candidate", () => {
  const cwd = mkdtempSync(join(tmpdir(), "diff-note-"));
  writeFileSync(join(cwd, "compiler.json"), JSON.stringify({ packageJson: join(cwd, "gone", "package.json") }), "utf8");
  const plugin = mkdtempSync(join(tmpdir(), "diff-note-plugin-"));
  const pkg = fakeCompiler(plugin);
  assert.equal(compilerPackage({ cwd, here: join(plugin, "dist"), repair: false }), pkg);
});

test("compilerPackage can use the bundled compiler under SINTY_INSTALL_ROOT", () => {
  const install = mkdtempSync(join(tmpdir(), "diff-install-"));
  const pkg = fakeCompiler(join(install, "plugins", "diffusion"));
  const cwd = mkdtempSync(join(tmpdir(), "diff-install-cwd-"));
  const here = mkdtempSync(join(tmpdir(), "diff-install-here-"));
  const prev = process.env.SINTY_INSTALL_ROOT;
  process.env.SINTY_INSTALL_ROOT = install;
  try {
    assert.equal(compilerPackage({ cwd, here, repair: false }), pkg);
  } finally {
    if (prev === undefined) delete process.env.SINTY_INSTALL_ROOT;
    else process.env.SINTY_INSTALL_ROOT = prev;
  }
});

test("compilerPackage does not run npm when repair is off and nothing is usable", () => {
  const cwd = mkdtempSync(join(tmpdir(), "diff-none-"));
  const here = mkdtempSync(join(tmpdir(), "diff-none-here-"));
  mkdirSync(join(cwd, "compiler"), { recursive: true });
  writeFileSync(join(cwd, "compiler", "package.json"), JSON.stringify({ name: "empty-compiler" }), "utf8");
  assert.equal(compilerPackage({ cwd, here, repair: false }), null);
});
