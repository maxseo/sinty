import { spawn } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DVT = "DevTools listening on ";

/** Адрес DevTools берём из stderr строкой, без регулярки: экранирование в патче ломается легче. */
function devtoolsUrl(text) {
  const at = text.lastIndexOf(DVT);
  if (at < 0)
    return "";
  const rest = text.slice(at + DVT.length);
  const stop = rest.search(/[\s"'<>]/);
  const url = stop < 0 ? rest : rest.slice(0, stop);
  return url.startsWith("ws://") ? url.trim() : "";
}

export function fileUrl(p) {
  const norm = p.replace(/\\/g, "/");
  return "file:///" + norm.split("/").map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join("/");
}

/** CDP-клиент на встроенном WebSocket, flatten-сессии. */
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.waiting = new Map();
    this.ready = new Promise((ok, fail) => {
      this.ws.addEventListener("open", () => ok());
      this.ws.addEventListener("error", () => fail(new Error("websocket error")));
    });
    this.ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
      }
      catch {
        return;
      }
      if (typeof msg.id !== "number")
        return;
      const slot = this.waiting.get(msg.id);
      if (!slot)
        return;
      this.waiting.delete(msg.id);
      if (msg.error)
        slot.reject(new Error(msg.error.message ?? "cdp error"));
      else
        slot.resolve(msg.result ?? {});
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 40_000) {
    const fire = () => new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method}: таймаут`));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const payload = { id, method, params };
      if (sessionId)
        payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
    return this.ws.readyState === WebSocket.OPEN ? fire() : this.ready.then(fire);
  }
  close() {
    try { this.ws.close(); } catch { /* уже закрыт */ }
  }
}

export async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.text ?? "ошибка в странице");
  return r.result?.value;
}

/**
 * Рендер без npm и без CLI.
 * fetch к 127.0.0.1 плагину запрещён, поэтому адрес DevTools берётся
 * из stderr Chromium, страница создаётся через Target.createTarget.
 * width/height у createTarget допустимы только с newWindow:true —
 * размер задаёт Emulation.setDeviceMetricsOverride.
 * Размер кадра берётся из data-width / data-height композиции, иначе
 * вертикальный ролик снимался бы как 1920x1080.
 */
export async function renderWithCdp(opts) {
  const {
    chrome, ffmpeg, htmlPath, outPath, profileDir,
    fps = 30, width = 1920, height = 1080,
    maxSeconds = 150, log = () => {},
  } = opts;

  let vw = width;
  let vh = height;

  mkdirSync(profileDir, { recursive: true });
  const port = 9400 + Math.floor(Math.random() * 400);
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--allow-file-access-from-files",
    "--force-device-scale-factor=1",
    `--window-size=${width},${height}`,
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "about:blank",
  ];

  log(`chromium: ${chrome}`);
  const browser = spawn(chrome, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  const wsUrl = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DevTools не поднялся: " + stderr.slice(-500))), 40_000);
    browser.stderr?.on("data", (b) => {
      stderr = (stderr + b.toString("utf8")).slice(-8000);
      const url = devtoolsUrl(stderr);
      if (url) {
        clearTimeout(timer);
        resolve(url);
      }
    });
    browser.on("error", (e) => { clearTimeout(timer); reject(e); });
    browser.on("close", (c) => { clearTimeout(timer); reject(new Error(`chromium закрылся (${c}): ${stderr.slice(-500)}`)); });
  });

  let cdp = null;
  let ff = null;
  const cleanup = () => {
    try { cdp?.close(); } catch { /* noop */ }
    try { browser.kill(); } catch { /* noop */ }
    try { ff?.kill(); } catch { /* noop */ }
  };

  try {
    const url = await wsUrl;
    log("DevTools: " + url.slice(0, 52) + "…");
    cdp = new Cdp(url);
    await cdp.ready;

    const created = await cdp.send("Target.createTarget", { url: fileUrl(htmlPath) });
    const targetId = created.targetId;
    if (!targetId)
      throw new Error("Target.createTarget не создал страницу");

    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached.sessionId;
    if (!sessionId)
      throw new Error("Target.attachToTarget без sessionId");

    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: vw, height: vh, deviceScaleFactor: 1, mobile: false,
    }, sessionId);

    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      try { ready = (await evaluate(cdp, sessionId, "typeof window.__render === 'function'")) === true; }
      catch { /* ещё грузится */ }
      if (!ready)
        await sleep(200);
    }
    if (!ready)
      throw new Error("страница не подняла window.__render (" + stderr.slice(-300) + ")");

    /* размер кадра — из композиции, а не из умолчания */
    try {
      const meta = await evaluate(cdp, sessionId, "(function(){var s=document.querySelector('[data-composition-id]')||document.getElementById('stage');if(!s)return null;return {w:Number(s.getAttribute('data-width')),h:Number(s.getAttribute('data-height'))};})()");
      if (meta && meta.w > 0 && meta.h > 0 && (meta.w !== vw || meta.h !== vh)) {
        vw = meta.w;
        vh = meta.h;
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: vw, height: vh, deviceScaleFactor: 1, mobile: false,
        }, sessionId);
        await sleep(120);
      }
    }
    catch { /* остаёмся на переданных размерах */ }

    const duration = Number(await evaluate(cdp, sessionId, "window.__hf.duration")) || 12;
    const pageFps = Number(await evaluate(cdp, sessionId, "window.__hf.fps")) || fps;
    const useFps = Math.min(fps, pageFps);
    const total = Math.max(1, Math.round(duration * useFps));
    log(`кадров: ${total} при ${useFps} fps, ${vw}x${vh}`);

    await evaluate(cdp, sessionId, "document.body.classList.add('render')");
    await sleep(250);

    ff = spawn(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(useFps), "-i", "-",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-pix_fmt", "yuv420p", "-r", String(useFps),
      "-movflags", "+faststart", outPath,
    ], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });

    let ffErr = "";
    ff.stderr?.on("data", (b) => { ffErr = (ffErr + b.toString("utf8")).slice(-2000); });
    const ffDone = new Promise((resolve, reject) => {
      ff.on("error", reject);
      ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg код " + code + ": " + ffErr.slice(-500)))));
    });

    const started = Date.now();
    for (let i = 0; i < total; i++) {
      if ((Date.now() - started) / 1000 > maxSeconds)
        throw new Error(`лимит ${maxSeconds} с: снято ${i} из ${total} кадров`);
      const t = i / useFps;
      await evaluate(cdp, sessionId,
        "new Promise(function(res){ window.__render(" + t + ");" +
        " requestAnimationFrame(function(){ requestAnimationFrame(function(){ res(1); }); }); })");
      const shot = await cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 92,
        captureBeyondViewport: false,
        fromSurface: true,
      }, sessionId, 30_000);
      const buf = Buffer.from(shot.data, "base64");
      if (!ff.stdin.write(buf))
        await new Promise((r) => ff.stdin.once("drain", r));
    }
    ff.stdin.end();
    await ffDone;
    const size = statSync(outPath).size;
    log(`готово: ${outPath} (${(size / 1048576).toFixed(2)} МБ)`);
    return { out: outPath, frames: total, fps: useFps, bytes: size, width: vw, height: vh };
  }
  finally {
    cleanup();
  }
}
