import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../api/server.js";
import { policySchema } from "../config.js";
import { boot, tempHome } from "./helpers.js";

const bearer = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

test("an admin with «Сотрудники» runs staff but cannot reach superadmin powers", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { policy: policySchema.parse({}) });
  try {
    const app = createApp(sinty);
    const { user: root } = sinty.accounts.setup({ email: "root@example.com", password: "secret-pass" });
    const adminRole = sinty.accounts.createRole("Админ");
    const all = { view: true, add: true, edit: true, delete: true };
    sinty.accounts.saveGrants(adminRole.id, [{ resource: "nav:staff", ...all }, { resource: "nav:chats", ...all }]);
    sinty.accounts.createUser({ email: "adm@example.com", password: "secret-pass", roleId: adminRole.id });
    const { token } = sinty.accounts.login("adm@example.com", "secret-pass");
    const h = bearer(token);

    assert.equal((await app.request("/v1/accounts/users", { headers: h })).status, 200, "admin sees staff");
    const other = sinty.accounts.createRole("Отдел");
    const made = await app.request("/v1/accounts/users", { method: "POST", headers: h, body: JSON.stringify({ email: "w@example.com", password: "secret-pass", roleId: other.id }) });
    assert.equal(made.status, 201, "admin adds a worker");

    const asSuper = await app.request("/v1/accounts/users", { method: "POST", headers: h, body: JSON.stringify({ email: "x@example.com", password: "secret-pass", roleId: root.roleId }) });
    assert.equal(asSuper.status, 403, "superadmin role is not for admins to hand out");
    assert.equal((await app.request(`/v1/accounts/users/${root.id}`, { method: "PATCH", headers: h, body: JSON.stringify({ enabled: false }) })).status, 403);
    assert.equal((await app.request(`/v1/accounts/users/${root.id}/reset-link`, { method: "POST", headers: h })).status, 403);
    assert.equal((await app.request(`/v1/accounts/roles/${adminRole.id}/grants`, { method: "PUT", headers: h, body: JSON.stringify({ grants: [{ resource: "settings:policy", ...all }] }) })).status, 403, "not own role");
    assert.equal((await app.request(`/v1/accounts/roles/${other.id}/grants`, { method: "PUT", headers: h, body: JSON.stringify({ grants: [{ resource: "settings:policy", ...all }] }) })).status, 403, "not a box the admin lacks");
    assert.equal((await app.request(`/v1/accounts/roles/${other.id}/grants`, { method: "PUT", headers: h, body: JSON.stringify({ grants: [{ resource: "nav:chats", view: true, add: false, edit: false, delete: false }] }) })).status, 200);

    assert.equal((await app.request("/v1/auth/rotate", { method: "POST", headers: h })).status, 403, "machine token stays with superadmin");
    const sections = (await (await app.request("/v1/settings/sections", { headers: h })).json()) as { sections: { id: string }[] };
    assert.equal(sections.sections.length, 0, "no skills, MCP or install sections without boxes");
    assert.equal((await app.request("/v1/settings", { headers: h })).status, 403);
    assert.equal((await app.request("/v1/skills/install", { method: "POST", headers: h, body: "{}" })).status, 403);

    const me = (await (await app.request("/v1/auth/me", { headers: h })).json()) as { can: Record<string, { view: boolean }> };
    assert.equal(me.can["nav:staff"]?.view, true);
    assert.equal(me.can["settings:policy"]?.view, false);
  } finally {
    await sinty.stop();
    cleanup();
  }
});
