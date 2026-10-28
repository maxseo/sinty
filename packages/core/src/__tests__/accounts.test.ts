import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccountError, Accounts } from "../accounts.js";

function open(): Accounts {
  return new Accounts(join(mkdtempSync(join(tmpdir(), "sinty-acc-")), "accounts.db"));
}

test("first person is superadmin and cannot be removed while last", () => {
  const a = open();
  try {
    assert.equal(a.hasUsers(), false);
    const { user, token } = a.setup({ email: "A@Example.com", password: "secret-pass", firstName: "Ann" });
    assert.equal(user.system, true);
    assert.equal(user.email, "a@example.com");
    assert.equal(a.userByToken(token)?.id, user.id);
    assert.throws(() => a.setup({ email: "b@example.com", password: "secret-pass" }), (e: unknown) => e instanceof AccountError && e.code === "already_setup");
    assert.throws(() => a.deleteUser(user.id), (e: unknown) => e instanceof AccountError && e.code === "last_superadmin");
    assert.equal(a.allows(user, "project:prj_x", "delete"), true);
  } finally {
    a.close();
  }
});

test("a role sees only the projects it was granted", () => {
  const a = open();
  try {
    const { user: admin } = a.setup({ email: "a@example.com", password: "secret-pass" });
    const role = a.createRole("Отдел");
    const person = a.createUser({ email: "m@example.com", password: "secret-pass", roleId: role.id });
    a.saveGrants(role.id, [{ resource: "project:prj_one", view: true, add: false, edit: false, delete: false }]);
    assert.equal(a.allows(person, "project:prj_one", "view"), true);
    assert.equal(a.allows(person, "project:prj_two", "view"), false);
    assert.throws(() => a.saveGrants(admin.roleId, []), (e: unknown) => e instanceof AccountError && e.code === "system_role");
    const link = a.resetLink(person.id);
    a.resetPassword(link, "another-pass");
    assert.equal(a.login("m@example.com", "another-pass").user.id, person.id);
    assert.throws(() => a.resetPassword(link, "third-pass-1"), (e: unknown) => e instanceof AccountError && e.code === "invalid_reset");
  } finally {
    a.close();
  }
});
