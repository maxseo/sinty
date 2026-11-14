import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { AccountError, Accounts } from "../accounts.js";

function open(file?: string): { a: Accounts; file: string } {
  const path = file ?? join(mkdtempSync(join(tmpdir(), "sinty-setup-")), "accounts.db");
  return { a: new Accounts(path), file: path };
}

test("setup refused after existing admin and survives reopen", () => {
  const { a, file } = open();
  try {
    assert.equal(a.hasUsers(), false);
    const first = a.setup({ email: "admin@example.com", password: "secret-pass" });
    assert.equal(first.user.system, true);
    assert.equal(a.hasUsers(), true);
    assert.throws(() => a.setup({ email: "two@example.com", password: "secret-pass" }), (e: unknown) => e instanceof AccountError && e.code === "already_setup" && e.status === 409);
    assert.equal(a.listUsers().length, 1);
    a.close();
    const again = new Accounts(file);
    try {
      assert.equal(again.hasUsers(), true);
      assert.equal(again.listUsers()[0]?.email, "admin@example.com");
      assert.throws(() => again.setup({ email: "three@example.com", password: "secret-pass" }), (e: unknown) => e instanceof AccountError && e.code === "already_setup");
    } finally {
      again.close();
    }
  } finally {
    try { a.close(); } catch { /* already closed */ }
  }
});

test("invalid password or email does not create a user", () => {
  const { a } = open();
  try {
    assert.throws(() => a.setup({ email: "admin@example.com", password: "short" }), (e: unknown) => e instanceof AccountError && e.code === "invalid_password");
    assert.throws(() => a.setup({ email: "not-an-email", password: "secret-pass" }), (e: unknown) => e instanceof AccountError && e.code === "invalid_email");
    assert.equal(a.hasUsers(), false);
  } finally {
    a.close();
  }
});

test("concurrent setup creates exactly one superadmin", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "sinty-setup-race-")), "accounts.db");
  const prep = new Accounts(file);
  prep.close();
  const worker = fileURLToPath(new URL("./auth-setup-worker.js", import.meta.url));
  const run = (email: string) =>
    new Promise<{ ok: boolean; id?: string; code?: string; system?: boolean; hasToken?: boolean }>((resolve, reject) => {
      const w = new Worker(worker, { workerData: { file, email } });
      let got: { ok: boolean; id?: string; code?: string; system?: boolean; hasToken?: boolean } | undefined;
      w.on("message", (m) => { got = m; });
      w.on("error", reject);
      w.on("exit", (code) => {
        if (code !== 0) reject(new Error(`worker exit ${code}`));
        else if (!got) reject(new Error("worker exited without a result"));
        else resolve(got);
      });
    });
  const results = await Promise.all([run("a@example.com"), run("b@example.com"), run("c@example.com")]);
  const wins = results.filter((r) => r.ok);
  const losses = results.filter((r) => !r.ok);
  assert.equal(wins.length, 1, JSON.stringify(results));
  assert.equal(wins[0]?.system, true);
  assert.equal(wins[0]?.hasToken, true);
  assert.ok(losses.every((r) => r.code === "already_setup"), JSON.stringify(results));
  const check = new Accounts(file);
  try {
    assert.equal(check.listUsers().length, 1);
    assert.equal(check.listUsers()[0]?.system, true);
  } finally {
    check.close();
  }
});
