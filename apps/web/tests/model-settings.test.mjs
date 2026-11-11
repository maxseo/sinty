import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const web = createRequire(new URL("../package.json", import.meta.url)), tools = createRequire(new URL("../../../plugins/tool-web/package.json", import.meta.url));
const { chromium } = tools("playwright"), { createServer } = await import(pathToFileURL(web.resolve("vite")).href), preact = web("@preact/preset-vite").default;
let server, browser, base;
before(async () => { server = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), plugins: [preact()], server: { host: "127.0.0.1", port: 0 }, logLevel: "error" }); await server.listen(); base = "http://127.0.0.1:" + server.httpServer.address().port; browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); await server?.close(); });
for (const theme of ["light", "dark"]) test("native model gear: inherited/current limit, zero, validation, reset/cancel, model/provider/agent isolation — " + theme, { timeout: 30000 }, async () => {
  const page = await browser.newPage(), errors = [], requests = []; let limit = 4040;
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/v1/models", route => { requests.push(route.request().method()); return route.fulfill({ json: { generation: { maxOutputTokens: limit, providers: { p: { protocol: "openai-compat", numericFields: ["temperature", "top_p", "top_k", "repeat_penalty", "repetition_penalty", "frequency_penalty", "presence_penalty"], reasoning: true, reasoningOff: false, thinkingBudget: false, cacheBreakpoints: false, cacheRoutingKey: true, modelSupport: "unknown" } } } } }); });
  const saved = async () => JSON.parse(await page.locator("#saved").textContent());
  const open = async () => { await page.getByRole("button", { name: "Настройки выбранной модели" }).click(); await page.getByLabel("Лимит токенов ответа").waitFor(); };
  try {
    await page.goto(base + "/tests/model-settings.fixture.html?theme=" + theme);
    await open(); assert.equal(await page.getByLabel("Лимит токенов ответа").getAttribute("placeholder"), "Наследовать общий: 4040");
    await page.getByLabel("Лимит токенов ответа").fill("0"); await page.getByRole("button", { name: "Применить к карточке" }).click(); await page.getByRole("alert").waitFor(); assert.equal((await saved()).one["p/a"], undefined);
    await page.getByLabel("Лимит токенов ответа").fill("1234"); await page.getByLabel("Ручные расширенные параметры").check(); await page.getByLabel("Temperature", { exact: true }).fill("0");
    assert.equal(await page.getByRole("option", { name: /^off/ }).count(), 0, "unsupported reasoning off must not be offered");
    await page.getByLabel("Передавать ключ маршрутизации prompt cache").selectOption("false"); await page.getByRole("button", { name: "Применить к карточке" }).click();
    assert.deepEqual((await saved()).one["p/a"], { maxOutputTokens: 1234, advanced: true, temperature: 0, promptCacheKey: false });
    await page.getByLabel("Модель", { exact: true }).selectOption("p/b"); await open(); assert.equal(await page.getByLabel("Лимит токенов ответа").inputValue(), "8000"); assert.equal(await page.getByLabel("Temperature", { exact: true }).inputValue(), "0.5"); await page.keyboard.press("Escape");
    await page.getByLabel("Модель", { exact: true }).selectOption("p/a"); await open(); await page.getByRole("button", { name: "Сбросить профиль" }).click(); await page.getByRole("button", { name: "Отмена", exact: true }).click(); assert.equal((await saved()).one["p/a"].maxOutputTokens, 1234, "cancel reset must not mutate card");
    await open(); await page.getByRole("button", { name: "Сбросить профиль" }).click(); await page.getByRole("button", { name: "Применить к карточке" }).click(); assert.equal((await saved()).one["p/a"], undefined); assert.equal((await saved()).one["p/b"].maxOutputTokens, 8000);
    limit = 9090; await open(); assert.equal(await page.getByLabel("Лимит токенов ответа").getAttribute("placeholder"), "Наследовать общий: 9090"); await page.keyboard.press("Escape");
    await page.getByLabel("Агент", { exact: true }).selectOption("two"); await page.getByLabel("Модель", { exact: true }).selectOption("p/b"); await open(); assert.equal(await page.getByLabel("Лимит токенов ответа").inputValue(), ""); assert.equal(await page.getByLabel("Ручные расширенные параметры").isChecked(), false); await page.keyboard.press("Escape");
    assert.deepEqual(errors, []); assert(requests.every(method => method === "GET"));
  } finally { await page.close(); }
});
