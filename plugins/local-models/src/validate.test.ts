import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCtxSize, parseGpuLayers, parseParallel, parsePort, parseAlias, isAbsolutePath, profileFields } from "./validate.js";

test("launch field validation accepts conservative defaults and rejects bad values", () => {
  assert.equal(parseCtxSize(0), 0);
  assert.equal(parseGpuLayers("auto"), "auto");
  assert.equal(parseGpuLayers(0), 0);
  assert.equal(parseParallel(-1), -1);
  assert.equal(parsePort(0), 0);
  assert.equal(parsePort(9931), 9931);
  assert.throws(() => parsePort(80), /1024/);
  assert.throws(() => parseCtxSize(-1), Error);
  assert.throws(() => parseAlias("../x"), Error);
  assert.equal(parseAlias("qwen-7b"), "qwen-7b");
  const p = profileFields({});
  assert.equal(p.host, "127.0.0.1");
  assert.equal(p.gpuLayers, "auto");
  assert.ok(isAbsolutePath("/models/a.gguf"));
  assert.ok(isAbsolutePath("C:\\\\models\\\\a.gguf") || isAbsolutePath("C:/models/a.gguf"));
  assert.equal(isAbsolutePath("models/a.gguf"), false);
});
