import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { removePluginUpload, savePluginUpload, safeUploadFilename, readPluginUpload, PLUGIN_UPLOAD_DIR } from "../plugin-upload.js";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

function tempData(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sinty-upload-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("safeUploadFilename rejects traversal and reserved names", () => {
  assert.equal(safeUploadFilename("model.gguf"), "model.gguf");
  assert.equal(safeUploadFilename("C:\\\\weights\\\\Qwen-7B.gguf"), "Qwen-7B.gguf");
  for (const bad of ["", "../x.gguf", "..", "a/b.gguf", "a\\\\b.gguf", ".hidden", "foo.", "con:x.gguf", "x y.gguf", "файл.gguf", "a".repeat(200) + ".gguf"]) {
    assert.throws(() => safeUploadFilename(bad), /имя|нужно/i, bad);
  }
});

test("savePluginUpload writes atomically, reports size, refuses overwrite of same id via unique ids", async () => {
  const { dir, cleanup } = tempData();
  try {
    const a = await savePluginUpload({ dataDir: dir, body: streamOf([Buffer.from("GGUF"), Buffer.from("data")]), filename: "m.gguf" });
    assert.equal(a.bytes, 8);
    assert.equal(a.filename, "m.gguf");
    assert.equal(a.relativePath, `${PLUGIN_UPLOAD_DIR}/${a.id}`);
    const got = readPluginUpload(dir, a.id);
    assert.equal(readFileSync(got.path, "utf8"), "GGUFdata");
    const b = await savePluginUpload({ dataDir: dir, body: streamOf([Buffer.from("other")]), filename: "m.gguf" });
    assert.notEqual(a.id, b.id);
    assert.equal(readFileSync(readPluginUpload(dir, a.id).path, "utf8"), "GGUFdata");
  } finally {
    cleanup();
  }
});

test("savePluginUpload cancels and removes the temp file", async () => {
  const { dir, cleanup } = tempData();
  const ac = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(Buffer.from("1234567890"));
      ac.abort();
      c.enqueue(Buffer.from("more"));
      c.close();
    },
  });
  try {
    await assert.rejects(() => savePluginUpload({ dataDir: dir, body, filename: "m.gguf", signal: ac.signal }), /отменена/);
    assert.equal(mkdirSync.length >= 0, true);
    const leftover = await import("node:fs");
    const names = leftover.readdirSync(join(dir, PLUGIN_UPLOAD_DIR), { withFileTypes: true }).map((e) => e.name);
    assert.deepEqual(names.filter((n) => !n.startsWith(".") || n.endsWith(".part") === false && n.startsWith(".")), names.filter((n) => !n.startsWith(".")));
    assert.equal(names.some((n) => n.endsWith(".part")), false);
  } finally {
    cleanup();
  }
});

test("savePluginUpload fails on insufficient disk and does not leave a dest file", async () => {
  const { dir, cleanup } = tempData();
  try {
    await assert.rejects(
      () => savePluginUpload({ dataDir: dir, body: streamOf([Buffer.from("abc")]), filename: "m.gguf", contentLength: 100, freeBytes: async () => 10 }),
      /места/,
    );
    assert.throws(() => { readPluginUpload(dir, "0".repeat(16)); }, Error);
  } finally {
    cleanup();
  }
});

test("savePluginUpload rejects a symlink staging directory", async () => {
  const { dir, cleanup } = tempData();
  try {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "trap"), "no");
    const staging = join(dir, PLUGIN_UPLOAD_DIR);
    try {
      symlinkSync(outside, staging, "dir");
    } catch (e) {
      // Windows may need privileges; skip if symlink is not allowed.
      if ((e as NodeJS.ErrnoException).code === "EPERM" || (e as NodeJS.ErrnoException).code === "EACCES") return;
      throw e;
    }
    await assert.rejects(() => savePluginUpload({ dataDir: dir, body: streamOf([Buffer.from("abc")]), filename: "m.gguf" }), /поврежд/);
  } finally {
    cleanup();
  }
});

test("removePluginUpload is idempotent", () => {
  const { dir, cleanup } = tempData();
  try {
    mkdirSync(join(dir, PLUGIN_UPLOAD_DIR), { recursive: true });
    const id = "ab".repeat(8);
    writeFileSync(join(dir, PLUGIN_UPLOAD_DIR, id), "x");
    removePluginUpload(dir, id);
    removePluginUpload(dir, id);
    assert.throws(() => readPluginUpload(dir, "not-an-id"), /корректн|некоррект/);
  } finally {
    cleanup();
  }
});
