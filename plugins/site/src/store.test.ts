import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SiteStore } from "./store.js";

test("site store: draft stays hidden, publish shows it, a closed page hides its body", () => {
  const dir = mkdtempSync(join(tmpdir(), "sinty-site-"));
  try {
    const store = new SiteStore(dir);
    const page = store.write({ kind: "page", title: "Главная", slug: "home", body: "привет" });
    assert.equal(page.status, "draft");
    assert.equal(store.published("home"), undefined);
    store.setStatus(page.id, "published");
    assert.equal(store.published("home")?.doc.body, "привет");

    const closed = store.write({ kind: "page", title: "Кабинет", slug: "account", body: "секрет", loginRequired: true });
    store.setStatus(closed.id, "published");
    const seen = store.published("account")!;
    assert.equal(seen.hidden, true);
    assert.equal(seen.doc.body, "");

    assert.throws(() => store.write({ kind: "post", title: "Ещё", slug: "home", body: "" }), /already used/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
