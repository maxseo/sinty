import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeServerPath, resolveExistingBinary } from "./engine.js";

test("engine path must be an absolute path on the Sinty machine", () => {
  assert.throws(() => normalizeServerPath("llama-server"), /абсолютн/);
  assert.throws(() => normalizeServerPath("https://example.com/llama-server"), /абсолютн/);
  assert.throws(() => normalizeServerPath("/tmp/../etc/llama-server"), /недопустим/);
  assert.throws(() => resolveExistingBinary("/definitely-missing-llama-server-bin-xyz"), /не найден|llama-server/);
});
