import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { bindModelCatalogRoute, unbindModelCatalogRoute } from "../model-bindings.js";
import type { SintyPaths } from "../paths.js";

function pathsOf(): { paths: SintyPaths; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "sinty-bind-"));
  mkdirSync(join(home, "workspace"));
  const config = join(home, "config.yaml");
  writeFileSync(
    config,
    [
      "providers:",
      "  openai:",
      "    protocol: openai-compat",
      "    baseUrl: https://api.openai.com/v1",
      "    apiKey: secret://openai",
      "  rh:",
      "    protocol: openai-compat",
      "    baseUrl: https://llm.runninghub.ai/v1",
      "models:",
      "  default: openai/gpt-4",
      "  fallback: [openai/gpt-4o-mini]",
      "  routes:",
      "    cheap: openai/gpt-4o-mini",
      "  catalog:",
      "    - { route: openai/gpt-4, enabled: true }",
      "    - { route: rh/model-a, enabled: true }",
      "plugins:",
      "  enabled: [ui-web]",
      "",
    ].join("\n"),
  );
  const paths = {
    home,
    config,
    workspace: join(home, "workspace"),
    data: join(home, "data"),
    plugins: join(home, "plugins"),
    skills: join(home, "skills"),
    agents: join(home, "AGENTS.md"),
    bundledPlugins: join(home, "bundled"),
    install: join(home, "install"),
  } as unknown as SintyPaths;
  return { paths, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("bindModelCatalogRoute adds one route and provider without wiping others, default, fallback or named routes", () => {
  const { paths, cleanup } = pathsOf();
  try {
    const known = { openai: { protocol: "openai-compat" }, rh: { protocol: "openai-compat" } };
    const r = bindModelCatalogRoute(paths, { route: "sinty-local/qwen", provider: { id: "sinty-local", protocol: "openai-compat", baseUrl: "http://127.0.0.1:18790/v1", apiKey: "k" } }, known);
    assert.equal(r.created, true);
    const again = bindModelCatalogRoute(paths, { route: "sinty-local/qwen", provider: { id: "sinty-local", protocol: "openai-compat", baseUrl: "http://127.0.0.1:18801/v1" } }, { ...known, "sinty-local": { protocol: "openai-compat" } });
    assert.equal(again.created, false);
    const doc = parseYaml(readFileSync(paths.config, "utf8")) as {
      providers: Record<string, { baseUrl?: string; apiKey?: string }>;
      models: { default: string; fallback: string[]; routes: Record<string, string>; catalog: { route: string }[] };
    };
    assert.equal(doc.models.default, "openai/gpt-4");
    assert.deepEqual(doc.models.fallback, ["openai/gpt-4o-mini"]);
    assert.equal(doc.models.routes.cheap, "openai/gpt-4o-mini");
    assert.deepEqual(doc.models.catalog.map((m) => m.route).sort(), ["openai/gpt-4", "rh/model-a", "sinty-local/qwen"]);
    assert.equal(doc.providers.openai!.baseUrl, "https://api.openai.com/v1");
    assert.equal(doc.providers.openai!.apiKey, "secret://openai");
    assert.equal(doc.providers.rh!.baseUrl, "https://llm.runninghub.ai/v1");
    assert.equal(doc.providers["sinty-local"]!.baseUrl, "http://127.0.0.1:18801/v1");
    assert.equal(doc.providers["sinty-local"]!.apiKey, "secret://sinty-local");
  } finally {
    cleanup();
  }
});

test("unbindModelCatalogRoute removes only that route and keeps the provider", () => {
  const { paths, cleanup } = pathsOf();
  try {
    const known = { openai: { protocol: "openai-compat" }, rh: { protocol: "openai-compat" } };
    bindModelCatalogRoute(paths, { route: "sinty-local/qwen", provider: { id: "sinty-local", baseUrl: "http://127.0.0.1:9/v1" } }, known);
    const r = unbindModelCatalogRoute(paths, "sinty-local/qwen");
    assert.equal(r.removed, true);
    assert.equal(unbindModelCatalogRoute(paths, "sinty-local/qwen").removed, false);
    const doc = parseYaml(readFileSync(paths.config, "utf8")) as {
      providers: Record<string, unknown>;
      models: { default: string; catalog: { route: string }[] };
    };
    assert.equal(doc.models.default, "openai/gpt-4");
    assert.deepEqual(doc.models.catalog.map((m) => m.route).sort(), ["openai/gpt-4", "rh/model-a"]);
    assert.ok(doc.providers["sinty-local"]);
    assert.ok(doc.providers.openai);
  } finally {
    cleanup();
  }
});

test("bindModelCatalogRoute rejects a route that does not match the provider id", () => {
  const { paths, cleanup } = pathsOf();
  try {
    assert.throws(
      () => bindModelCatalogRoute(paths, { route: "other/qwen", provider: { id: "sinty-local", baseUrl: "http://127.0.0.1:9/v1" } }, {}),
      /начинаться/,
    );
  } finally {
    cleanup();
  }
});
