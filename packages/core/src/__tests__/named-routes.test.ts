import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { loadConfig, saveNamedRoutes, saveSettings } from "../config.js";
import { resolvePaths } from "../paths.js";
import { tempHome } from "./helpers.js";

test("saveNamedRoutes: omitted keys preserve existing routes; empty clears only the patched key", () => {
  const { home, cleanup } = tempHome();
  try {
    const paths = resolvePaths(home);
    const raw = readFileSync(paths.config, "utf8");
    writeFileSync(
      paths.config,
      raw.replace(
        "routes: {}",
        "routes:\n    cheap: deepseek/deepseek-chat\n    vision: deepseek/deepseek-chat\n    custom: deepseek/deepseek-chat\n",
      ),
    );
    const providers = loadConfig(paths).providers;

    const next = saveNamedRoutes(paths, { cheap: "", vision: "deepseek/deepseek-reasoner" }, providers);
    assert.equal(next.cheap, undefined);
    assert.equal(next.vision, "deepseek/deepseek-reasoner");
    assert.equal(next.custom, "deepseek/deepseek-chat");

    const file = parse(readFileSync(paths.config, "utf8")) as { models: { routes: Record<string, string> } };
    assert.equal(file.models.routes.cheap, undefined);
    assert.equal(file.models.routes.vision, "deepseek/deepseek-reasoner");
    assert.equal(file.models.routes.custom, "deepseek/deepseek-chat");
  } finally {
    cleanup();
  }
});

test("saveSettings: omitted fallback does not wipe models.fallback", () => {
  const { home, cleanup } = tempHome();
  try {
    const paths = resolvePaths(home);
    const cfg = loadConfig(paths);
    const model = cfg.models.default || "deepseek/deepseek-chat";
    saveSettings(paths, { model, fallback: ["deepseek/deepseek-reasoner"], enabled: ["ui-web"] }, cfg.providers);
    let mid = loadConfig(paths);
    assert.deepEqual(mid.models.fallback, ["deepseek/deepseek-reasoner"]);

    saveSettings(paths, { model, enabled: ["ui-web"] }, mid.providers);
    mid = loadConfig(paths);
    assert.deepEqual(mid.models.fallback, ["deepseek/deepseek-reasoner"]);
  } finally {
    cleanup();
  }
});