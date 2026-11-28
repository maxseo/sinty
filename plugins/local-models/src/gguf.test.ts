import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectGguf, findSiblingShards, parseShardName } from "./gguf.js";
import { writeGguf } from "./gguf-build.js";

function dir(): { d: string; cleanup: () => void } {
  const d = mkdtempSync(join(tmpdir(), "gguf-"));
  return { d, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

test("inspectGguf reads architecture and does not treat a projector as a checkpoint", () => {
  const { d, cleanup } = dir();
  try {
    const model = join(d, "qwen.gguf");
    writeGguf(model, { "general.architecture": "qwen2", "general.name": "Qwen", "qwen2.context_length": 32768 });
    const info = inspectGguf(model);
    assert.equal(info.kind, "checkpoint");
    assert.equal(info.architecture, "qwen2");
    assert.equal(info.contextLength, 32768);
    const proj = join(d, "qwen-mmproj-f16.gguf");
    writeGguf(proj, { "general.architecture": "clip", "general.name": "projector", "clip.has_vision_encoder": true });
    const p = inspectGguf(proj);
    assert.equal(p.kind, "mmproj");
    assert.match(p.reason ?? "", /проектор/);
  } finally {
    cleanup();
  }
});

test("inspectGguf rejects a non-GGUF file", () => {
  const { d, cleanup } = dir();
  try {
    const f = join(d, "x.gguf");
    writeFileSync(f, "not a model");
    assert.throws(() => inspectGguf(f), /GGUF/);
  } finally {
    cleanup();
  }
});

test("findSiblingShards requires a complete set and keeps order", () => {
  const { d, cleanup } = dir();
  try {
    assert.equal(parseShardName("model-00001-of-00003.gguf")?.total, 3);
    writeGguf(join(d, "model-00001-of-00003.gguf"), { "general.architecture": "qwen2" });
    writeGguf(join(d, "model-00002-of-00003.gguf"), { "general.architecture": "qwen2" });
    assert.throws(() => findSiblingShards(join(d, "model-00001-of-00003.gguf")), /3 частей/);
    writeGguf(join(d, "model-00003-of-00003.gguf"), { "general.architecture": "qwen2" });
    const all = findSiblingShards(join(d, "model-00002-of-00003.gguf"));
    assert.equal(all?.length, 3);
    assert.ok(all?.[0]?.endsWith("model-00001-of-00003.gguf"));
    assert.equal(findSiblingShards(join(d, "plain.gguf")), undefined);
  } finally {
    cleanup();
  }
});
