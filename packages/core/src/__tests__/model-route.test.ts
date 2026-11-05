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

test("a new provider stores its key reference in the same write", () => {
  const dir = mkdtempSync(join(tmpdir(), "sinty-route-"));
  const config = join(dir, "config.yaml");
  writeFileSync(config, "providers:\n  deepseek: { protocol: openai-compat, baseUrl: https://api.deepseek.com/v1 }\nmodels: {}\n");
  saveModelCatalog({ config } as SintyPaths, [
    { route: "openrouter/openai/whisper-1", enabled: true },
  ], [{ id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", protocol: "openai-compat", apiKey: "sk-test" }], {});
  const text = readFileSync(config, "utf8");
  assert.match(text, /apiKey: secret:\/\/openrouter/);
  assert.doesNotMatch(text, /sk-test/);
  saveModelCatalog({ config } as SintyPaths, [
    { route: "openrouter/openai/whisper-1", enabled: true },
  ], [{ id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", protocol: "openai-compat", apiKey: "sk-next" }], { openrouter: { protocol: "openai-compat" } });
  assert.match(readFileSync(config, "utf8"), /apiKey: secret:\/\/openrouter/);
  assert.doesNotMatch(readFileSync(config, "utf8"), /sk-next/);
});
