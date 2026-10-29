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
    const page = store.write({ kind: "page", title: "Главная", home: true, body: "привет" });
    assert.equal(page.home, true);
    assert.throws(() => store.write({ kind: "page", title: "Ещё главная", home: true }), /уже есть/);
    assert.equal(page.status, "draft");
    assert.equal(store.homePage(), undefined);
    store.setStatus(page.id, "published");
    assert.equal(store.homePage()?.doc.body, "привет");

    const closed = store.write({ kind: "page", title: "Кабинет", slug: "account", body: "секрет", loginRequired: true });
    store.setStatus(closed.id, "published");
    const seen = store.published("account")!;
    assert.equal(seen.hidden, true);
    assert.equal(seen.doc.body, "");

    assert.throws(() => store.write({ kind: "post", title: "Ещё", slug: "account", body: "" }), /занят/);

    const tpl = store.write({ kind: "template", title: "Шапка", slug: "header" });
    store.setLayout(tpl.id, [{ rows: [{ cols: [{ widgets: [{ type: "title", props: { text: "Синти" } }] }] }] }]);
    store.setLayout(page.id, [{ rows: [{ cols: [{ widgets: [{ type: "text", props: { text: "низ" } }] }] }] }]);
    const withTpl = store.useTemplate(page.id, tpl.id);
    assert.equal(withTpl.layout.length, 2);
    assert.equal(withTpl.layout[1]?.rows[0]?.cols[0]?.widgets[0]?.type, "dynamic_block");

    const token = store.registerVisitor("a@b.co", "password1");
    assert.equal(store.published("account", true)?.hidden, false);
    assert.equal(store.published("account", true)?.doc.body, "секрет");
    assert.ok(store.visitorFromToken(token)?.email === "a@b.co");
    assert.throws(() => store.loginVisitor("a@b.co", "wrong-pass"), /wrong/);

    const req = store.addRequest("account", { name: "Анна", email: "a@b.co", telegram: "@anna", message: "хочу счёт" });
    assert.equal(req.status, "pending");
    assert.equal(store.requests("pending")[0]?.fields.telegram, "@anna");
    assert.equal(store.setRequestStatus(req.id, "sent").status, "sent");

    const chat = store.openChat("abc");
    store.addChatMessage(chat.id, "visitor", "есть доставка?");
    store.addChatMessage(chat.id, "agent", "да");
    assert.equal(store.chatMessages(chat.id).length, 2);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
