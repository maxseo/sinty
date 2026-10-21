import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolError } from "@sinty/sdk";
import { blockedReason, HINTS, httpError, toWebError } from "./errors.ts";

const PRIVATE = /Private hosts are blocked/;

test("http errors: own codes with the status and host, and hints that fit the status", () => {
  const e401 = httpError(401, "Unauthorized", "https://www.dns-shop.ru/product/x/");
  assert.equal(e401.code, "http_4xx");
  assert.equal(e401.message, "page returned 401 Unauthorized (www.dns-shop.ru)");
  assert.match(e401.hint!, /anti-bot/);
  assert.match(e401.hint!, /web\.interact/);
  assert.equal(httpError(403, "", "https://a.test/").hint, HINTS.antibot);
  const e429 = httpError(429, "Too Many Requests", "https://a.test/");
  assert.match(e429.hint!, /rate-limits/);
  assert.match(e429.hint!, /web\.interact/);
  const e404 = httpError(404, "Not Found", "https://lite-store.ru/x");
  assert.equal(e404.code, "http_4xx");
  assert.match(e404.hint!, /web\.search or web\.links/);
  const e502 = httpError(502, "Bad Gateway", "https://a.test/");
  assert.equal(e502.code, "http_5xx");
  for (const e of [e401, e429, e404, e502]) assert.doesNotMatch(e.hint!, PRIVATE, e.message);
});

test("core errors keep their code; the private-host hint only for net_blocked", () => {
  const big = toWebError(new ToolError("too_large", "response is larger than 1500000 bytes"));
  assert.equal(big.code, "too_large");
  assert.match(big.hint!, /web\.interact/);
  assert.doesNotMatch(big.hint!, PRIVATE);
  const blocked = toWebError(new ToolError("net_blocked", "127.0.0.1 is a loopback address; private addresses are blocked", { hint: "Only public http(s) pages. Private hosts are blocked." }));
  assert.equal(blocked.code, "net_blocked");
  assert.match(blocked.hint!, PRIVATE);
  for (const code of ["timeout", "net_failed", "bad_request"]) {
    const e = toWebError(new ToolError(code, "x", { hint: "Only public http(s) pages. Private hosts are blocked." }));
    assert.equal(e.code, code);
    assert.doesNotMatch(e.hint!, PRIVATE, code);
  }
  const http = httpError(404, "", "https://a.test/");
  assert.equal(toWebError(http), http, "an http error passes through");
  const aborted = new ToolError("aborted", "cancelled");
  assert.equal(toWebError(aborted), aborted);
});

test("other errors are web_failed without the private-host hint; browser network errors get a network code", () => {
  const sel = toWebError(new Error("page.click: Timeout 8000ms exceeded. waiting for locator('#buy')"));
  assert.equal(sel.code, "web_failed");
  assert.doesNotMatch(sel.hint!, PRIVATE);
  assert.equal(toWebError(new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at http://10.0.0.1/")).code, "net_blocked");
  assert.equal(toWebError(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://nope.invalid/")).code, "net_failed");
  assert.equal(toWebError(new Error("page.goto: Timeout 20000ms exceeded.\nnavigating to \"https://a.test/\"")).code, "timeout");
  assert.equal(toWebError("boom").code, "web_failed");
});

test("blocked pages: an error status, a captcha title, or a short page with captcha text; normal pages are not", () => {
  assert.match(blockedReason(403, "Яндекс Маркет", "")!, /HTTP 403/);
  assert.match(blockedReason(200, "Вы не робот?", "")!, /captcha/);
  assert.match(blockedReason(200, "Ой!", "Нам очень жаль, но запросы с вашего IP похожи на автоматические. Слишком много запросов. Подтвердите, что вы не робот.")!, /captcha/);
  assert.match(blockedReason(undefined, "Just a moment...", "")!, /captcha/);
  assert.equal(blockedReason(200, "PlayStation 5 Pro — купить", "Цена 79 990 ₽"), undefined);
  assert.equal(blockedReason(200, "How CAPTCHAs work", "x".repeat(5000) + " captcha"), undefined, "a long article about captchas is content");
  assert.equal(blockedReason(undefined, "Local", "Hi"), undefined);
});
