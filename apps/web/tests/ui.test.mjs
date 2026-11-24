import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const webRequire = createRequire(new URL("../package.json", import.meta.url));
const toolRequire = createRequire(new URL("../../../plugins/tool-web/package.json", import.meta.url));
const { chromium } = toolRequire("playwright");
const { createServer } = await import(pathToFileURL(webRequire.resolve("vite")).href);
const preact = webRequire("@preact/preset-vite").default;
let vite, browser, base;
const shots = fileURLToPath(new URL("../../../.git/agent-backups/select-skills-kit-20261110/screenshots/", import.meta.url));
before(async () => {
 vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), plugins: [preact()], server: { host: "127.0.0.1", port: 0, strictPort: false }, logLevel: "error" });
 await vite.listen(); base = "http://127.0.0.1:" + vite.httpServer.address().port;
 browser = await chromium.launch({ headless: true }); await mkdir(shots, { recursive: true });
});
after(async () => { await browser?.close(); await vite?.close(); });
async function fixture(view = "select", theme = "light") {
 const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
 const writes = [], errors = [];
 page.on("pageerror", error => errors.push(error.message));
 await page.route("**/v1/**", async route => {
  const request = route.request(), url = new URL(request.url());
  if (request.method() !== "GET") writes.push({ path: url.pathname, body: request.postDataJSON() });
  let json = { ok: true };
  if (url.pathname === "/v1/models") json = { models: Array.from({ length: 35 }, (_, i) => ({ route: "provider/model-" + i, enabled: true })) };
  if (url.pathname === "/v1/roster/skills") json = { skills: [{ name: "fixture-skill", description: "Живой список из API теста" }, { name: "second-skill", description: "Второй навык" }] };
  if (url.pathname === "/v1/settings/sections") json = { sections: [{ id: "plugin.skills", values: { catalogLimit: 60 } }] };
  await route.fulfill({ json });
 });
 await page.route("**/p/**", async route => {
  const request = route.request(), url = new URL(request.url());
  if (request.method() !== "GET") writes.push({ path: url.pathname, body: request.postDataJSON() });
  const json = url.pathname === "/p/skills/item" ? { name: "fixture-skill", description: "fixture", text: "---\nname: fixture-skill\n---\n# Instruction", truncated: false, files: ["SKILL.md", "reference.md"] } : { text: "Reference content", ok: true };
  await route.fulfill({ json });
 });
 await page.goto(base + "/tests/ui.fixture.html?view=" + view + "&theme=" + theme);
 return { page, writes, errors };
}
async function visible(locator) { await locator.waitFor({ state: "visible" }); }
for (const theme of ["light", "dark"]) {
 test("shared select escapes overflow/transform, keyboard/outside/focus — " + theme, { timeout: 30000 }, async () => {
  const { page, errors } = await fixture("select", theme);
  try {
   const trigger = page.locator("#model-card .cselect-btn"); await visible(trigger);
   await page.waitForFunction(() => document.querySelector("#model-card .cselect-btn")?.textContent.includes("model-0"));
   await trigger.click(); const menu = page.locator(".cselect-menu"); await visible(menu);
   assert.equal(await menu.evaluate(el => el.parentElement === document.body), true);
   const box = await menu.boundingBox(), card = await page.locator("#model-card").boundingBox();
   assert.ok(box.y + box.height > card.y + card.height + 40, "menu extends beyond clipping card");
   assert.equal(await menu.evaluate(el => getComputedStyle(el).position), "fixed");
   assert.equal(await page.locator(".cselect-options").getAttribute("role"), "listbox");
   await page.waitForTimeout(180); await page.screenshot({ path: join(shots, "agent-model-" + theme + ".png") });
   await trigger.press("End"); assert.ok(await menu.evaluate(el => el.scrollTop) > 0);
   await trigger.press("Enter"); await page.waitForFunction(() => document.querySelector("#picked").textContent === "provider/model-34");
   assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("cselect-btn")), true);
   await trigger.click(); await trigger.press("Escape"); assert.equal(await menu.count(), 0);
   await trigger.click(); await page.getByLabel("Внешнее поле").click(); assert.equal(await menu.count(), 0);
   assert.equal(await page.getByLabel("Внешнее поле").evaluate(el => document.activeElement === el), true);
   assert.deepEqual(errors, []);
  } finally { await page.close(); }
 });
 test("viewport flip, resize and ancestor-scroll anchoring — " + theme, { timeout: 30000 }, async () => {
  const { page } = await fixture("select", theme);
  try {
   const edge = page.getByRole("combobox", { name: "Нижний список" }); await edge.click();
   let menu = page.locator(".cselect-menu"); await visible(menu);
   assert.equal(await menu.getAttribute("data-placement"), "top");
   await page.setViewportSize({ width: 420, height: 420 });
   await page.waitForTimeout(80); let box = await menu.boundingBox(); assert.ok(box.x >= 7 && box.x + box.width <= 413 && box.y >= 7 && box.y + box.height <= 413);
   await edge.press("Escape"); await page.setViewportSize({ width: 1280, height: 800 });
   const trigger = page.locator("#model-card .cselect-btn"); await trigger.click(); await visible(menu);
   const before = await menu.boundingBox(); await page.locator("#scrollbox").evaluate(el => { el.scrollTop = 20; });
   await page.waitForTimeout(80); const after = await menu.boundingBox(); assert.ok(Math.abs((before.y - after.y) - 20) < 2);
   await page.locator("#scrollbox").evaluate(el => { el.scrollTop = 600; }); await menu.waitFor({ state: "detached" });
  } finally { await page.close(); }
 });
 test("approved UI Kit: 46 specimens, real selects, 40px controls and safe local demos — " + theme, { timeout: 30000 }, async () => {
  const { page, writes, errors } = await fixture("kit", theme);
  try {
   await visible(page.locator(".kit-showcase")); assert.equal(await page.locator("article.specimen").count(), 46);
   const heights = await page.locator('.kit-showcase .field input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), .kit-showcase .cselect-btn, .kit-showcase .igroup, .kit-showcase .search').evaluateAll(els => els.map(el => ({ label: el.getAttribute("aria-label") || el.type, height: el.getBoundingClientRect().height })));
   assert.ok(heights.length >= 10); assert.deepEqual(heights.filter(x => Math.abs(x.height - 40) > 0.1), []);
   assert.equal(await page.locator("button button").count(), 0);
   assert.equal(await page.locator(".kit-showcase input[type=radio]").evaluateAll(els => els.every(el => getComputedStyle(el).opacity === "1" && el.getBoundingClientRect().width > 0)), true);
   await page.screenshot({ path: join(shots, "uikit-top-" + theme + ".png") });
   assert.equal(await page.locator(".cselect-btn .chev").evaluateAll(els => els.every(el => el.getBoundingClientRect().width === 16 && el.getBoundingClientRect().height === 16)), true);
   const toggler = page.locator('[data-specimen="control.toggle"] button.tog').first();
   const pressed = await toggler.getAttribute("aria-pressed"); await toggler.click(); assert.notEqual(await toggler.getAttribute("aria-pressed"), pressed);
   const search = page.getByPlaceholder("Компонент, состояние или токен"); await search.fill("select");
   assert.ok(await page.locator("article.specimen").count() < 46); await search.fill("");
   await page.locator('[data-specimen="select"]').scrollIntoViewIfNeeded();
   const select = page.getByRole("combobox", { name: "Селект с поиском", exact: true }); await select.click();
   await page.getByLabel("Поиск: Селект с поиском").fill("claude"); assert.equal(await page.getByRole("option").count(), 1);
   await page.getByLabel("Поиск: Селект с поиском").press("Enter"); assert.ok((await select.textContent()).includes("claude-sonnet"));
   const multi = page.getByRole("combobox", { name: "Мультиселект", exact: true }); await multi.click();
   await page.getByRole("option", { name: /whisper-1/ }).click(); assert.equal(await multi.locator(".cselect-chip").count(), 3);
   assert.equal(await multi.getByRole("button", { name: "Убрать whisper-1" }).count(), 1);
   await multi.getByRole("button", { name: "Убрать whisper-1" }).click(); assert.equal(await multi.locator(".cselect-chip").count(), 2);
   await multi.press("Escape"); await page.waitForTimeout(180); await page.screenshot({ path: join(shots, "uikit-selects-" + theme + ".png") });
   await page.locator('[data-specimen="feedback"]').getByRole("button", { name: "Показать тост" }).click(); await visible(page.locator(".toast"));
   assert.deepEqual(writes, []); assert.deepEqual(errors, []);
  } finally { await page.close(); }
 });
 test("Skills approved layout retains catalog, limit, viewer and command install — " + theme, { timeout: 30000 }, async () => {
  const { page, writes, errors } = await fixture("skills", theme);
  try {
   await page.getByRole("button", { name: /fixture-skill/ }).waitFor();
   assert.equal(await page.locator(".skills-pane .card").count(), 1); assert.equal(await page.locator(".skills-pane .plugin-av").count(), 2);
   await page.screenshot({ path: join(shots, "skills-" + theme + ".png") });
   await page.getByLabel("Навыков в каталоге").fill("77"); await page.getByRole("button", { name: "Сохранить лимит" }).click();
   await page.waitForFunction(() => document.body.textContent.includes("Лимит каталога сохранён")); assert.ok(writes.some(w => w.body?.values?.catalogLimit === 77));
   await page.getByRole("button", { name: /fixture-skill/ }).click(); await visible(page.getByRole("dialog", { name: "fixture-skill" }));
   await page.getByRole("button", { name: "reference.md" }).click(); await page.getByText("Reference content", { exact: true }).waitFor(); await page.getByRole("button", { name: "Закрыть" }).click();
   await page.getByRole("button", { name: "Добавить навык", exact: true }).click(); await page.getByPlaceholder("npx skills add владелец/репозиторий").fill("npx skills add example/fixture");
   await page.getByRole("button", { name: "Установить навык командой" }).click(); await page.getByRole("button", { name: /fixture-skill/ }).waitFor();
   assert.ok(writes.some(w => w.path === "/v1/skills/install" && w.body.command === "npx skills add example/fixture")); assert.deepEqual(errors, []);
  } finally { await page.close(); }
 });

 test("Skills manual and zip actions keep their existing API contracts — " + theme, { timeout: 30000 }, async () => {
  const { page, writes, errors } = await fixture("skills", theme);
  try {
   await page.getByRole("button", { name: /fixture-skill/ }).waitFor();
   await page.getByRole("button", { name: "Добавить навык", exact: true }).click();
   await page.getByRole("button", { name: "Добавить скилл", exact: true }).click();
   const dialog = page.getByRole("dialog", { name: "Новый скилл" }); await visible(dialog);
   await dialog.getByLabel("Папка / slug (опционально)").fill("browser-skill");
   await dialog.getByLabel("Название", { exact: true }).fill("Browser skill");
   await dialog.getByLabel("Описание", { exact: true }).fill("Fixture description");
   await dialog.getByLabel("Когда использовать", { exact: true }).fill("During fixture tests");
   await dialog.getByLabel("Инструкции (SKILL.md body)").fill("Keep fixture actions local.");
   await dialog.getByRole("button", { name: "Сохранить", exact: true }).click(); await dialog.waitFor({ state: "detached" });
   assert.ok(writes.some(w => w.path === "/p/skills/import" && w.body.name === "browser-skill" && w.body.text.includes("Keep fixture actions local.")));
   await page.getByRole("button", { name: "Добавить навык", exact: true }).click();
   await page.locator('input[type="file"][accept=".zip,application/zip"]').setInputFiles({ name: "fixture.zip", mimeType: "application/zip", buffer: Buffer.from("fixture-only") });
   await page.getByRole("button", { name: /fixture-skill/ }).waitFor();
   assert.ok(writes.some(w => w.path === "/v1/skills/install" && w.body.zipBase64 === Buffer.from("fixture-only").toString("base64")));
   assert.deepEqual(errors, []);
  } finally { await page.close(); }
 });
}
