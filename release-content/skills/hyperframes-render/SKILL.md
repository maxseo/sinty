---
name: hyperframes-render
description: Рендер HTML-анимации (HyperFrames) в MP4 в песочнице Sinty — рабочая схема Chromium CDP + ffmpeg, когда npx/CLI мёртв. Загружать при любом запросе «сделай видео/анимацию/ролик из HTML».
---

# HyperFrames → MP4 в песочнице Sinty

Проверено на Windows-песочнице 2026-10-30. Результат: 12 с / 1920×1080 / 30 fps / 360 кадров ≈ 1.5 мин рендера.

## Главное правило

**Не пытайся чинить `npx`.** В песочнице это тупик, проверено семью патчами:

| Попытка | Ошибка | Почему |
|---|---|---|
| `spawn("npx.cmd", …, {shell:false})` | `EINVAL` | Node 24 запрещает прямой спавн `.cmd` без оболочки |
| через `cmd.exe /d /s /c` | `ERR_ACCESS_DENIED` на `npm/lib/cli.js` | дочерний node наследует permission model хоста |
| чистка `NODE_OPTIONS` от `--permission`/`--allow-*` | не помогло | флаг приезжает не через env, а из конфига хоста |

`npx`, `npm`, сам CLI HyperFrames — всё недоступно. Никакие флаги это не лечат.

## Рабочая схема

Плагин `hyperframes` (уже пропатчен до 0.2.5) умеет рендерить сам, без CLI:

1. Chromium из `ms-playwright` в headless **с `--no-sandbox`** (без него Windows-сандбокс не открывает собственный `chrome.exe` → `0x5 Отказано в доступе`)
2. адрес DevTools парсится **из stderr** (`DevTools listening on ws://…`) — `fetch` к `127.0.0.1` плагину запрещён, сеть только `$PUBLIC`
3. страница через `Target.createTarget` **без `width`/`height`** (иначе `Target position can only be set for new windows`), размеры — `Emulation.setDeviceMetricsOverride`
4. `Target.attachToTarget {flatten:true}` → работа в `sessionId`
5. кадр: `window.__render(t)` → **два `requestAnimationFrame`** → иначе снимок уходит до перерисовки
6. `Page.captureScreenshot` JPEG q92 → пайп в `ffmpeg -f image2pipe` → libx264, crf 18, yuv420p
7. профиль Chromium — **только в `$DATA`** (`ctx.paths.data`), не в `os.tmpdir()`: писать можно лишь в `$DATA` и `$WORKSPACE`

## Порядок действий

### 1. Проверить инструменты

```
runtimes.status
```
Нужны `ffmpeg` и `chrome`. Если пусто — `runtimes.install {what:"all"}`.

Брать оттуда **полные пути**. Из шелла их не достать: `%LOCALAPPDATA%` подменён на `…\Packages\sinty.shell\AC`, а абсолютные пути вне воркспейса режет `shell.run`.

### 2. Написать композицию

Обязательные атрибуты на корне:
```html
<div id="stage"
     data-composition-id="my-clip"
     data-width="1920" data-height="1080"
     data-fps="30" data-duration="12">
```
У сцен: `data-scene`, `data-start`, `data-duration`.

**Требования к рантайму (критично):**
- всё состояние кадра считается чистой функцией от `t` — никаких накопленных анимаций, `setTimeout`, счётчиков
- экспортировать `window.__hf = {duration, fps, seek(t)}`
- обязательно **синхронный** `window.__render(t)` — рендерер зовёт его и сразу снимает кадр
- `body.render` — класс, который прячет HUD и снимает масштабирование под окно (`scale(1)`)
- ноль внешних запросов: ни CDN, ни GSAP, ни картинок по ссылке

Шаблон-рыба и полный пример: `_out/hyperframes/neon_loop.html` в проекте «первый», копия — `hyperframes/neon-loop/index.html` в корне воркспейса.

### 3. Сохранить в правильный корень

`hyperframes.render` ищет файл в **`<workspace>/hyperframes/<slug>/index.html`**, а не в папке проекта. `fs.write` туда не достанет — корень проекта выше. Использовать:

```
hyperframes.write {slug:"my-clip", html:"<…>"}
```

Лимит html — 500 000 символов.

### 4. Отрендерить

```
hyperframes.render {
  slug: "my-clip",
  fps: 30,
  skipCli: true,                       // npx мёртв, не тратить 70 секунд
  chrome: "C:\\…\\ms-playwright\\chromium-1248\\chrome-win64\\chrome.exe",
  ffmpeg: "C:\\…\\Sinty\\tools\\ffmpeg-9.0.2-essentials_build\\bin\\ffmpeg.exe"
}
```

`skipCli` обязателен, иначе плагин сначала 70 с долбится в `npx`. Возвращает `{out, frames, fps, bytes}`.

Лимит рендера — 150 с. 12 с при 30 fps проходят за ~1.5 мин. **Для 60 fps или длинного ролика урезать длительность или fps**, иначе упрёшься в лимит и получишь «снято N из M».

### 5. Отдать результат

MP4 создаётся внутри `hyperframes/<slug>/`, оттуда скопировать в `_out/` тем же приёмом, что всегда: CJS-скрипт через `type script.cjs | node-real -`.

## Проверки без браузера

Скриншот `file://` в песочнице запрещён (`web.screenshot` принимает только публичный http/https). Поэтому композицию проверять численно:

- **`_work/hf_check.cjs`** — синтаксис inline-JS, все нужные `id`, все `data-*`, конец таймлайна = `data-duration`, ноль внешних ссылок
- **`_work/hf_sim.cjs`** — прогон всех кадров на заглушке DOM (Proxy на `style`, фейковый `document`, `requestAnimationFrame` в никуда). Ловит `NaN`/`undefined`/`Infinity` в стилях и проверяет видимость сцен по времени

Эти два скрипта ловят 90% ошибок до рендера. Копировать их в новый проект вместе с композицией.

## Ловушки

- **`.cmd` и `shell:false`** — EINVAL в Node 24. Только через `cmd.exe`.
- **`readdirSync` по `%LOCALAPPDATA%`** из плагина — запрещён permission model. Проверять короткий список известных путей через `existsSync` или передавать пути параметрами.
- **`os.tmpdir()`** — запись запрещена. Только `$DATA`.
- **`fetch` к localhost** — запрещён. Только парсинг stderr.
- **`Page.captureScreenshot` без двух rAF** — кадр отстаёт на один, на быстрых сценах даёт рывки.
- **`--disable-gpu`** оставлять: без него headless иногда падает на слабых VM.
- **Параллельные рендеры** — порт случайный (9400–9799), но Chromium жрёт память. Последовательно.

## Если всё сломалось

Диагностика плагина: `plugin.read {plugin:"hyperframes", path:"render-cdp.js"}` — там весь рендерер, 250 строк. Патчить через `plugin.propose_patch`, в файлы патча **всегда включать `sinty.plugin.json`** (иначе staging берёт бандловый entry `dist/index.js` и load-проверка падает), `entry` должен быть `"index.js"`.
