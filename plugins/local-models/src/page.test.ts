import assert from "node:assert/strict";
import { test } from "node:test";
import { tabHtml } from "./page.js";

test("tab html has boundary notice, statuses and no fake engine-install button", () => {
  const html = tabHtml();
  assert.match(html, /Локальные модели/);
  assert.match(html, /не в браузере/);
  assert.match(html, /GET \/health/);
  assert.match(html, /Загрузить GGUF/);
  assert.match(html, /Зарегистрировать путь/);
  assert.match(html, /llama-server/);
  assert.doesNotMatch(html, /Установить официальн/);
  assert.doesNotMatch(html, /PowerShell/);
  assert.match(html, /op: "upload"/);
  assert.match(html, /catalog-bind/);
});
