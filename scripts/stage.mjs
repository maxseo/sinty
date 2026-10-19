import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dirname, "..");
const stage = join(root, "build", "stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

function copyDist(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of ["package.json", "sinty.plugin.json", "README.md"]) {
    const src = join(from, name);
    try { cpSync(src, join(to, name)); } catch { /* optional */ }
  }
  if (statExists(join(from, "dist"))) cpSync(join(from, "dist"), join(to, "dist"), { recursive: true });
  if (statExists(join(from, "public"))) cpSync(join(from, "public"), join(to, "public"), { recursive: true });
}

function statExists(p) {
  try { return statSync(p).isDirectory() || statSync(p).isFile(); } catch { return false; }
}

for (const name of ["sdk", "core", "supervisor", "cli"]) copyDist(join(root, "packages", name), join(stage, "packages", name));
const shellBox = join(root, "packages", "core", "sandbox", "ShellBox.exe");
if (statExists(shellBox)) {
  mkdirSync(join(stage, "packages", "core", "dist", "sandbox"), { recursive: true });
  cpSync(shellBox, join(stage, "packages", "core", "dist", "sandbox", "ShellBox.exe"));
}
for (const name of readdirSync(join(root, "plugins"))) {
  if (name === "example-echo") continue;
  copyDist(join(root, "plugins", name), join(stage, "plugins", name));
}
cpSync(join(root, "schemas"), join(stage, "schemas"), { recursive: true });
if (statExists(join(root, "registry"))) cpSync(join(root, "registry"), join(stage, "registry"), { recursive: true });
if (statExists(join(root, "site"))) cpSync(join(root, "site"), join(stage, "site"), { recursive: true });

function rewrite(pkgPath) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.private = false;
  for (const key of ["dependencies", "devDependencies"]) {
    for (const [name, ver] of Object.entries(pkg[key] ?? {})) {
      if (ver === "workspace:*") pkg[key][name] = "file:" + relative(dirname(pkgPath), join(stage, "packages", name.replace("@sinty/", ""))).split("\\").join("/");
    }
  }
  delete pkg.devDependencies;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}
for (const dir of [join(stage, "packages"), join(stage, "plugins")]) {
  for (const name of readdirSync(dir)) {
    const pkg = join(dir, name, "package.json");
    if (statExists(pkg)) rewrite(pkg);
  }
}
const deps = {};
for (const dir of [join(stage, "packages"), join(stage, "plugins")]) {
  for (const name of readdirSync(dir)) {
    const pkgPath = join(dir, name, "package.json");
    if (!statExists(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    deps[pkg.name] = "file:" + relative(stage, join(dir, name)).split("\\").join("/");
  }
}
writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "sinty-install", private: true, type: "module", dependencies: deps }, null, 2));

const install = spawnSync("npm", ["install", "--omit=dev", "--no-package-lock"], { cwd: stage, stdio: "inherit", shell: true, env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } });
if (install.status !== 0) process.exit(install.status ?? 1);

const files = {};
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "src", "__tests__"].includes(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs);
    else if (!entry.name.endsWith(".map") && !entry.name.endsWith(".ts") && entry.name !== "integrity.json") {
      files[relative(stage, abs).split("\\").join("/")] = createHash("sha256").update(readFileSync(abs)).digest("hex");
    }
  }
}
for (const name of ["packages", "plugins", "schemas"]) walk(join(stage, name));
writeFileSync(join(stage, "integrity.json"), JSON.stringify({ files }, null, 2));
mkdirSync(join(stage, "bin"), { recursive: true });
writeFileSync(join(stage, "bin", "sinty.cmd"), `@echo off\r\nset "SINTY_INSTALL_ROOT=%~dp0.."\r\nnode "%SINTY_INSTALL_ROOT%\\packages\\cli\\dist\\bin.js" %*\r\n`);
writeFileSync(join(stage, "bin", "sinty"), `#!/bin/sh\ncd "$(dirname "$0")/.." || exit 1\nexport SINTY_INSTALL_ROOT="$PWD"\nexec node "$SINTY_INSTALL_ROOT/packages/cli/dist/bin.js" "$@"\n`);
console.log(`staged ${Object.keys(files).length} files at ${stage}`);
