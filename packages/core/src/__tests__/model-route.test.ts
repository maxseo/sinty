import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { saveModelCatalog } from "../config.js";
import type { SintyPaths } from "../paths.js";

test("a model id may contain slashes after the provider name", () => {
  const dir = mkdtempSync(join(tmpdir(), "sinty-route-"));
  const config = join(dir, "config.yaml");
  writeFileSync(config, "providers: {}\nmodels: {}\n");
  const saved = saveModelCatalog({ config } as SintyPaths, [
    { route: "runninghub/openai/gpt-6.1-sol-saver", enabled: true },
    { route: "not-a-route", enabled: true },
  ], [{ id: "runninghub", baseUrl: "https://llm.runninghub.ai/v1", protocol: "openai-compat" }], {});
  assert.deepEqual(saved.map((m) => m.route), ["runninghub/openai/gpt-6.1-sol-saver"]);
  assert.match(readFileSync(config, "utf8"), /runninghub\/openai\/gpt-6\.1-sol-saver/);
});
