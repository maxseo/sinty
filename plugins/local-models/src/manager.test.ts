import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { test } from "node:test";
import { LocalModelsManager } from "./manager.js";
import type { InstanceStatus } from "./types.js";
import { writeGguf } from "./gguf-build.js";
import { loadRegistry } from "./registry.js";
import { checkHealth } from "./process.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fake-llama-server.js");

function temp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lm-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.SINTY_LOCAL_MODELS_TEST;
  process.env.SINTY_LOCAL_MODELS_TEST = "1";
  process.env.FAKE_LLAMA_LOAD_MS = "30";
  delete process.env.FAKE_LLAMA_FAIL;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SINTY_LOCAL_MODELS_TEST;
    else process.env.SINTY_LOCAL_MODELS_TEST = prev;
    delete process.env.FAKE_LLAMA_FAIL;
  }
}

function binary(dir: string): string {
  const dest = join(dir, "llama-server.js");
  copyFileSync(fixture, dest);
  return dest;
}

test("import, register path, persist registry, reject mmproj as the main model and path traversal", async () => {
  const { dir, cleanup } = temp();
  try {
    const mgr = new LocalModelsManager({ dataDir: join(dir, "data") });
    const model = join(dir, "qwen.gguf");
    writeGguf(model, { "general.architecture": "qwen2", "general.name": "Qwen Test" });
    const asset = await mgr.commitImport({ filePaths: [model], title: "Qwen" });
    assert.equal(asset.source, "import");
    assert.equal(asset.title, "Qwen");
    assert.ok(existsSync(asset.files[0]!.path));
    const proj = join(dir, "mmproj.gguf");
    writeGguf(proj, { "general.architecture": "clip", "general.name": "mmproj" });
    await assert.rejects(() => mgr.commitImport({ filePaths: [proj] }), /проектор/);
    const outside = join(dir, "on-disk.gguf");
    writeGguf(outside, { "general.architecture": "qwen2", "general.name": "Disk" });
    const registered = mgr.registerExistingPath(outside);
    assert.equal(registered.source, "path");
    assert.equal(registered.files[0]!.path, outside);
    assert.throws(() => mgr.registerExistingPath("../etc/passwd"), /абсолютн|не найден|путь/i);
    const again = loadRegistry(join(dir, "data"));
    assert.equal(again.assets.length, 2);
    assert.equal(again.autostart, false);
    const mgr2 = new LocalModelsManager({ dataDir: join(dir, "data") });
    assert.equal(mgr2.load().assets.length, 2);
  } finally {
    cleanup();
  }
});

test("manager starts one server, health becomes ready, stop is confirmed, second start is refused while running", async () => {
  const { dir, cleanup } = temp();
  await withEnv(async () => {
    const mgr = new LocalModelsManager({ dataDir: join(dir, "data") });
    try {
      await mgr.selectEngine(binary(dir));
      const model = join(dir, "m.gguf");
      writeGguf(model, { "general.architecture": "qwen2" });
      const asset = await mgr.commitImport({ filePaths: [model] });
      const profile = mgr.load().profiles.find((p) => p.assetId === asset.id)!;
      const inst = await mgr.start(profile.id);
      assert.ok(inst.port > 0);
      assert.ok(inst.status === "loading" || inst.status === "ready");
      const start = Date.now();
      let status: InstanceStatus = inst.status;
      while (status !== "ready" && Date.now() - start < 4000) {
        await new Promise((r) => setTimeout(r, 50));
        status = (await mgr.refreshHealth()).status;
      }
      assert.equal(status, "ready");
      const health = await checkHealth(inst.port, inst.apiKey);
      assert.equal(health.status, "ready");
      await assert.rejects(() => mgr.start(profile.id), /уже запущен/);
      await assert.rejects(() => mgr.stop(false), /подтвержд/);
      await mgr.stop(true);
      assert.equal(mgr.load().instance, null);
      const after = await checkHealth(inst.port, inst.apiKey);
      assert.equal(after.status, "down");
    } finally {
      await mgr.dispose();
      cleanup();
    }
  });
});

test("foreign process on a reserved port is not adopted and not killed", async () => {
  const { dir, cleanup } = temp();
  const foreign = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });
  await new Promise<void>((r) => foreign.listen(0, "127.0.0.1", r));
  const addr = foreign.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  await withEnv(async () => {
    const mgr = new LocalModelsManager({ dataDir: join(dir, "data") });
    try {
      await mgr.selectEngine(binary(dir));
      const model = join(dir, "m.gguf");
      writeGguf(model, { "general.architecture": "qwen2" });
      const asset = await mgr.commitImport({ filePaths: [model] });
      const profile = mgr.saveProfile({ ...mgr.load().profiles.find((p) => p.assetId === asset.id), port });
      await assert.rejects(() => mgr.start(profile.id), /занят другим процессом/);
      const still = await (await fetch("http://127.0.0.1:" + port + "/health")).text();
      assert.match(still, /ok/);
      assert.equal(mgr.load().instance, null);
    } finally {
      await mgr.dispose();
      await new Promise<void>((r) => foreign.close(() => r()));
      cleanup();
    }
  });
});

test("reconcile after a new manager instance adopts a live own server and does not start a second one; dispose stops it", async () => {
  const { dir, cleanup } = temp();
  await withEnv(async () => {
    const dataDir = join(dir, "data");
    const first = new LocalModelsManager({ dataDir });
    try {
      await first.selectEngine(binary(dir));
      const model = join(dir, "m.gguf");
      writeGguf(model, { "general.architecture": "qwen2" });
      const asset = await first.commitImport({ filePaths: [model] });
      const profile = first.load().profiles.find((p) => p.assetId === asset.id)!;
      const inst = await first.start(profile.id);
      const start = Date.now();
      while ((await first.refreshHealth()).status !== "ready" && Date.now() - start < 4000) await new Promise((r) => setTimeout(r, 50));
      const second = new LocalModelsManager({ dataDir });
      await second.reconcile();
      const rec = second.load().instance;
      assert.ok(rec);
      assert.equal(rec!.port, inst.port);
      assert.ok(rec!.status === "ready" || rec!.status === "loading");
      assert.equal(second.load().assets.length, 1);
      await second.stop(true);
      assert.equal((await checkHealth(inst.port, inst.apiKey)).status, "down");
    } finally {
      await first.dispose();
      cleanup();
    }
  });
});

test("catalog binding keeps a stable route and is independent of stop", async () => {
  const { dir, cleanup } = temp();
  try {
    const mgr = new LocalModelsManager({ dataDir: join(dir, "data") });
    const model = join(dir, "m.gguf");
    writeGguf(model, { "general.architecture": "qwen2" });
    const asset = await mgr.commitImport({ filePaths: [model] });
    const profile = mgr.load().profiles.find((p) => p.assetId === asset.id)!;
    const bound = mgr.bindCatalog(profile.id, "qwen-local");
    assert.equal(bound.route, "sinty-local/qwen-local");
    const again = mgr.bindCatalog(profile.id, "qwen-local");
    assert.equal(again.route, "sinty-local/qwen-local");
    assert.equal(mgr.load().bindings.length, 1);
    mgr.unbindCatalog(bound.route);
    assert.equal(mgr.load().bindings.length, 0);
    assert.equal(mgr.load().assets.length, 1);
  } finally {
    cleanup();
  }
});

test("lifecycle dispose stops the owned process and keeps files", async () => {
  const { dir, cleanup } = temp();
  await withEnv(async () => {
    const dataDir = join(dir, "data");
    const mgr = new LocalModelsManager({ dataDir });
    try {
      await mgr.selectEngine(binary(dir));
      const model = join(dir, "m.gguf");
      writeGguf(model, { "general.architecture": "qwen2" });
      await mgr.commitImport({ filePaths: [model] });
      const profile = mgr.load().profiles[0]!;
      const inst = await mgr.start(profile.id);
      await mgr.dispose();
      assert.equal((await checkHealth(inst.port, inst.apiKey)).status, "down");
      assert.equal(loadRegistry(dataDir).assets.length, 1);
      assert.ok(existsSync(loadRegistry(dataDir).assets[0]!.files[0]!.path));
    } finally {
      cleanup();
    }
  });
});
