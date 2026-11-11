import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { test } from "node:test";
import { createApp } from "../api/server.js";
import { DEFAULT_ON_PLUGINS, loadConfig, saveNamedRoutes } from "../config.js";
import { boot, tempHome } from "./helpers.js";

test("POST /v1/models/bindings adds one route without wiping existing providers, default, fallback or named routes", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { plugins: ["fake-provider"] });
  try {
    // Seed a catalog and a second provider, plus fallback and a named route.
    sinty.config.providers["rh"] = { protocol: "openai-compat", baseUrl: "https://llm.runninghub.ai/v1" };
    const app = createApp(sinty);
    const auth = { authorization: `Bearer ${sinty.secrets.get("api.token")!}` };
    const put = await app.request("/v1/models", {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        models: [{ route: "fake/test-model", enabled: true }],
        providers: [{ id: "rh", protocol: "openai-compat", baseUrl: "https://llm.runninghub.ai/v1" }],
      }),
    });
    const putText = await put.text();
    assert.equal(put.status, 200, putText);
    // Named routes may target a plugin-provided model not yet in yaml providers; seed after catalog PUT.
    saveNamedRoutes(sinty.paths, { cheap: "fake/test-model" }, { ...sinty.config.providers, fake: { protocol: "openai-compat" } });
    const mid = loadConfig(sinty.paths);
    sinty.config.models = mid.models;
    sinty.config.providers = mid.providers;
    const defaultBefore = sinty.config.models.default;
    const fallbackBefore = [...(sinty.config.models.fallback ?? [])];
    const bound = await app.request("/v1/models/bindings", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        route: "sinty-local/qwen",
        provider: { id: "sinty-local", protocol: "openai-compat", baseUrl: "http://127.0.0.1:18790/v1", apiKey: "secret-key" },
      }),
    });
    assert.equal(bound.status, 200);
    const body = (await bound.json()) as { route: string; created: boolean };
    assert.equal(body.route, "sinty-local/qwen");
    assert.equal(body.created, true);
    const listed = (await (await app.request("/v1/models", { headers: auth })).json()) as {
      models: { route: string }[];
      providers: { id: string; baseUrl: string; hasKey: boolean }[];
      routes: Record<string, string>;
      serviceModel: string;
    };
    const routes = listed.models.map((m) => m.route);
    assert.ok(routes.includes("fake/test-model"));
    assert.ok(routes.includes("sinty-local/qwen"));
    assert.ok(listed.providers.some((p) => p.id === "rh" && p.baseUrl.includes("runninghub")));
    assert.ok(listed.providers.some((p) => p.id === "sinty-local" && p.baseUrl.includes("127.0.0.1:18790") && p.hasKey));
    assert.equal(listed.routes.cheap, "fake/test-model");
    // Bind must not rewrite models.default / fallback; PUT catalog also leaves default unchanged.
    assert.equal(sinty.config.models.default, defaultBefore);
    assert.deepEqual(sinty.config.models.fallback, fallbackBefore);
    const again = await app.request("/v1/models/bindings", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ route: "sinty-local/qwen", provider: { id: "sinty-local", baseUrl: "http://127.0.0.1:18801/v1" } }),
    });
    assert.equal(((await again.json()) as { created: boolean }).created, false);
    const doc = parseYaml(readFileSync(sinty.paths.config, "utf8")) as { providers: Record<string, { baseUrl: string }> };
    assert.equal(doc.providers["sinty-local"]!.baseUrl, "http://127.0.0.1:18801/v1");
    const del = await app.request("/v1/models/bindings", {
      method: "DELETE",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ route: "sinty-local/qwen" }),
    });
    assert.equal(del.status, 200);
    const after = (await (await app.request("/v1/models", { headers: auth })).json()) as { models: { route: string }[]; providers: { id: string }[] };
    assert.ok(!after.models.some((m) => m.route === "sinty-local/qwen"));
    assert.ok(after.providers.some((p) => p.id === "sinty-local"));
    assert.ok(after.models.some((m) => m.route === "fake/test-model"));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("POST /v1/plugin-data/:plugin/uploads streams bytes into plugin $DATA and rejects a bad filename", async () => {
  assert.ok(DEFAULT_ON_PLUGINS.includes("usage"));
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { plugins: ["fake-provider"] });
  try {
    const app = createApp(sinty);
    const auth = { authorization: `Bearer ${sinty.secrets.get("api.token")!}` };
    const payload = Buffer.from("GGUFhello");
    const res = await app.request("/v1/plugin-data/usage/uploads?filename=model.gguf", {
      method: "POST",
      headers: { ...auth, "content-type": "application/octet-stream", "content-length": String(payload.length) },
      body: payload,
    });
    const resText = await res.text();
    assert.equal(res.status, 201, resText);
    const body = JSON.parse(resText) as { id: string; filename: string; bytes: number; relativePath: string };
    assert.equal(body.filename, "model.gguf");
    assert.equal(body.bytes, payload.length);
    assert.equal(body.relativePath, `.uploads/${body.id}`);
    const file = (await import("node:fs")).readFileSync((await import("node:path")).join(sinty.paths.data, "usage", ".uploads", body.id));
    assert.equal(file.toString("utf8"), "GGUFhello");
    const bad = await app.request("/v1/plugin-data/usage/uploads?filename=../x.gguf", {
      method: "POST",
      headers: { ...auth, "content-type": "application/octet-stream" },
      body: Buffer.from("abc"),
    });
    assert.equal(bad.status, 400);
    const missing = await app.request("/v1/plugin-data/no-such-plugin/uploads?filename=model.gguf", {
      method: "POST",
      headers: { ...auth, "content-type": "application/octet-stream" },
      body: Buffer.from("abc"),
    });
    assert.equal(missing.status, 404);
  } finally {
    await sinty.stop();
    cleanup();
  }
});
