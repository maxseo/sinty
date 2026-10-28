import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { PluginManifest } from "@sinty/sdk";
import { accessRegistry, registryIds, routeRight, type RegistryPlugin } from "../access-registry.js";
import { Accounts } from "../accounts.js";
import { createApp } from "../api/server.js";
import type { SintyConfig } from "../config.js";
import { boot, FIXTURES, tempHome } from "./helpers.js";

const manifest = (extra: Partial<PluginManifest>): PluginManifest => ({ name: "demo", version: "1.0.0", main: "dist/index.js", ...extra }) as PluginManifest;
const demo = (extra: Partial<PluginManifest>, disabled = false): RegistryPlugin => ({ name: "demo", disabled, manifest: manifest(extra) });

test("every plugin tab and settings section becomes a right; a disabled plugin shows none", () => {
  const p = demo({ ui: { tabs: [{ id: "board", title: "Доска", builtin: "board" }, { id: "files", title: "Файлы", path: "/tab", placement: "project" }] }, settings: { title: "Демо", fields: [] } as never });
  const groups = accessRegistry({ plugins: [p], coreSections: [{ id: "policy", title: "Политика" }], projects: [{ id: "prj_1", name: "Сайт" }] });
  assert.deepEqual(groups.map((g) => g.id), ["panel", "settings", "plugin:demo", "projects"]);
  const ids = registryIds(groups);
  for (const id of ["nav:chats", "settings:general", "settings:policy", "ui:demo/board", "ui:demo/files", "ui:demo/settings", "project:prj_1"]) assert.ok(ids.includes(id), id);
  const off = accessRegistry({ plugins: [{ ...p, disabled: true }], coreSections: [], projects: [] });
  assert.ok(!registryIds(off).some((id) => id.startsWith("ui:demo")));
});

test("route rights: surface, else the first tab, else settings; action follows the method", () => {
  const tabs = demo({ ui: { tabs: [{ id: "board", title: "Доска", builtin: "board" }, { id: "files", title: "Файлы", path: "/tab", placement: "project" }] } });
  assert.deepEqual(routeRight(tabs, { method: "GET", path: "/x", public: false }, "GET"), { resource: "ui:demo/board", action: "view", placement: "sidebar" });
  assert.deepEqual(routeRight(tabs, { method: "PATCH", path: "/x", public: false }, "PATCH"), { resource: "ui:demo/board", action: "edit", placement: "sidebar" });
  assert.deepEqual(routeRight(tabs, { method: "POST", path: "/x", public: false, surface: "files", access: "edit" }, "POST"), { resource: "ui:demo/files", action: "edit", placement: "project" });
  const settingsOnly = demo({ settings: { title: "Демо", fields: [] } as never });
  assert.deepEqual(routeRight(settingsOnly, { method: "DELETE", path: "/x", public: false }, "DELETE"), { resource: "ui:demo/settings", action: "delete", placement: "settings" });
  assert.equal(routeRight(demo({}), { method: "GET", path: "/x", public: false }, "GET"), undefined, "no screen, no person-facing route");
});

test("old panel grants move to the new rights once; a right that appears later is new and closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "sinty-acc-"));
  const file = join(dir, "accounts.db");
  try {
    let acc = new Accounts(file);
    const role = acc.createRole("Отдел");
    const all = { view: true, add: true, edit: true, delete: true };
    acc.close();
    const db = new DatabaseSync(file);
    db.prepare("INSERT INTO grants (role_id, resource, can_view, can_add, can_edit, can_delete) VALUES (?, 'nav:board', 1, 1, 1, 1)").run(role.id);
    db.prepare("DELETE FROM meta WHERE key = 'grants_v2'").run();
    db.close();

    acc = new Accounts(file);
    const grants = acc.grants(role.id);
    assert.ok(grants.some((g) => g.resource === "ui:kanban/board" && g.edit));
    assert.ok(!grants.some((g) => g.resource === "nav:board"));

    acc.noteResources(["nav:chats", "ui:kanban/board"]);
    acc.saveGrants(role.id, [{ resource: "nav:chats", ...all }]);
    const later = ["nav:chats", "ui:kanban/board", "ui:demo/files"];
    const t = Date.now();
    while (Date.now() === t) {}
    assert.deepEqual([...acc.noteResources(later, role.id)], ["ui:demo/files"]);
    const user = acc.createUser({ email: "w@example.com", password: "secret-pass", roleId: role.id });
    assert.equal(acc.capabilities(user, later)["ui:demo/files"]?.view, false);

    assert.equal(acc.dropOrphans(new Set(["demo"]), new Set()), 1, "kanban is gone, its grant goes");
    acc.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a person sees a plugin tab and calls its routes only with that tab's right, and only for chats they see", async () => {
  const { home, cleanup } = tempHome();
  const config: Partial<SintyConfig> = {
    providers: { rec: { protocol: "rec", options: { script: {} } } },
    models: { default: "rec/main", fallback: [], routes: {}, catalog: [], maxOutputTokens: 1000 },
    plugins: { enabled: ["recording-provider", "context-inspector"], config: {}, searchPaths: [FIXTURES], inspect: ["context-inspector"] },
  };
  const sinty = await boot(home, [], { config, plugins: [] });
  try {
    const app = createApp(sinty);
    sinty.accounts.setup({ email: "root@example.com", password: "secret-pass" });
    const role = sinty.accounts.createRole("Отдел");
    sinty.accounts.createUser({ email: "w@example.com", password: "secret-pass", roleId: role.id });
    const h = { authorization: `Bearer ${sinty.accounts.login("w@example.com", "secret-pass").token}` };
    const tabsOf = async () =>
      ((await (await app.request("/v1/plugins", { headers: h })).json()) as { plugins: { name: string; tabs: unknown[] }[] }).plugins.find((p) => p.name === "context-inspector")!.tabs;

    assert.deepEqual(await tabsOf(), [], "closed by default");
    assert.equal((await app.request("/p/context-inspector/sessions", { headers: h })).status, 403);

    sinty.accounts.saveGrants(role.id, [{ resource: "ui:context-inspector/context", view: true, add: false, edit: false, delete: false }]);
    assert.equal((await tabsOf()).length, 1);
    assert.equal((await app.request("/p/context-inspector/sessions", { headers: h })).status, 200);
    const s = sinty.agent.createSession();
    assert.equal((await app.request(`/p/context-inspector/snapshots?session=${s.id}`, { headers: h })).status, 403, "the tab right does not open someone else's chat");
  } finally {
    await sinty.stop();
    cleanup();
  }
});
