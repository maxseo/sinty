import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { createApp } from "../api/server.js";
import { boot, tempHome } from "./helpers.js";
import { resolvePaths } from "../paths.js";

test("settings sections: policy listed; saving writes policy.yaml live; invalid values 400", async () => {
  const { home, cleanup } = tempHome();
  const paths = resolvePaths(home);
  writeFileSync(paths.policy, `${readFileSync(paths.policy, "utf8")}\n# keep my note\n`);
  const sinty = await boot(home, []);
  try {
    const app = createApp(sinty);
    const auth = { authorization: `Bearer ${sinty.secrets.get("api.token")!}`, "content-type": "application/json" };
    const { sections } = (await (await app.request("/v1/settings/sections", { headers: auth })).json()) as {
      sections: { id: string; title: string; store?: string; values: Record<string, unknown>; defaults: Record<string, unknown> }[];
    };
    const pol = sections.find((s) => s.id === "policy");
    assert.ok(pol, "policy section present");
    assert.equal(pol.title, "Политика");
    assert.equal(pol.store, "policy.yaml");
    assert.equal(pol.values.mode, "standard");
    assert.equal(pol.values["defaults.write"], "ask");
    assert.equal(pol.values["defaults.external"], "ask");
    assert.equal(pol.defaults["defaults.write"], "ask");

    const put = (values: Record<string, unknown>) =>
      app.request("/v1/settings/sections/policy", { method: "PUT", headers: auth, body: JSON.stringify({ values }) });

    const ok = await put({ "defaults.write": "allow", "defaults.external": "deny", mode: "strict" });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { restart: boolean; section: { values: Record<string, unknown>; store: string } };
    assert.equal(body.restart, false);
    assert.equal(body.section.store, "policy.yaml");
    assert.equal(body.section.values["defaults.write"], "allow");
    assert.equal(sinty.policy.defaults.write, "allow", "applied live without restart");
    assert.equal(sinty.policy.defaults.external, "deny");
    assert.equal(sinty.policy.mode, "strict");

    const yaml = readFileSync(paths.policy, "utf8");
    assert.match(yaml, /# keep my note/);
    assert.match(yaml, /write: allow/);
    assert.match(yaml, /external: deny/);
    assert.match(yaml, /mode: strict/);
    // tools map from the default file must survive a defaults-only edit
    assert.match(yaml, /fs\.read/);

    assert.equal((await put({ "defaults.write": "maybe" })).status, 400);
    assert.equal(sinty.policy.defaults.write, "allow", "rejected write leaves live policy");
    assert.equal((await put({ mode: "loose" })).status, 400);
    assert.equal((await put({ "tools.shell.*": "allow" })).status, 400, "unknown field");
    assert.equal((await put({ "defaults.write": null })).status, 400, "defaults are required");
  } finally {
    await sinty.stop();
    cleanup();
  }
});
