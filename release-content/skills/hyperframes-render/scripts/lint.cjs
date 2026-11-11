/* Проверка HyperFrames-композиции: синтаксис, id, data-*, конец таймлайна.
   Конфиг: _work/hf_target.json  {"html": "_out/hyperframes/neon_loop.html"}
   Запуск: type lint.cjs | node-real -     (argv в песочнице недоступен) */
const fs = require("fs");

let cfg = { html: "_out/hyperframes/neon_loop.html" };
try {
  cfg = Object.assign(cfg, JSON.parse(fs.readFileSync("_work/hf_target.json", "utf8")));
} catch (e) {
  console.log("WARN нет _work/hf_target.json, беру " + cfg.html);
}

const p = cfg.html;
if (!fs.existsSync(p)) { console.log("FAIL нет файла " + p); process.exit(1); }
const src = fs.readFileSync(p, "utf8");
let fail = 0;
const ok = (m) => console.log("OK  " + m);
const bad = (m) => { console.log("FAIL " + m); fail++; };

/* 1. inline-скрипт и его синтаксис */
const m = src.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { bad("нет inline <script>"); process.exit(1); }
try { new Function(m[1]); ok("синтаксис JS"); }
catch (e) { bad("синтаксис: " + e.message); }

/* 2. обязательные API рантайма */
for (const api of ["window.__hf", "window.__render"]) {
  src.includes(api) ? ok(api + " объявлен") : bad("нет " + api);
}

/* 3. data-* на корне */
const rootAttrs = ["data-composition-id", "data-width", "data-height", "data-fps", "data-duration"];
const missRoot = rootAttrs.filter((a) => !src.includes(a));
missRoot.length ? bad("нет атрибутов корня: " + missRoot.join(", ")) : ok("data-* корня на месте");

/* 4. сцены: тайминг сходится с data-duration */
const durs = [...src.matchAll(/data-start="([\d.]+)"[^>]*data-duration="([\d.]+)"/g)]
  .map((x) => ({ start: +x[1], dur: +x[2] }));
if (!durs.length) bad("нет сцен с data-start/data-duration");
else {
  const end = Math.max(...durs.map((d) => +(d.start + d.dur).toFixed(3)));
  const declared = +((src.match(/data-duration="([\d.]+)"/) || [])[1] || 0);
  ok("сцен: " + durs.length + ", конец таймлайна: " + end);
  Math.abs(end - declared) < 0.051
    ? ok("тайминг сходится с data-duration=" + declared)
    : bad("конец таймлайна " + end + " ≠ data-duration " + declared);
  /* дырки и наложения */
  const sorted = durs.slice().sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = +(sorted[i - 1].start + sorted[i - 1].dur).toFixed(3);
    if (Math.abs(prevEnd - sorted[i].start) > 0.051)
      bad("разрыв/наложение: конец " + prevEnd + " → старт " + sorted[i].start);
  }
}

/* 5. ноль внешних запросов */
const ext = [...src.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((x) => x[1]);
ext.length ? bad("внешние ссылки: " + ext.join(", ")) : ok("ноль внешних зависимостей");

/* 6. размер под лимит hyperframes.write */
(src.length <= 500000)
  ? ok("размер " + (src.length / 1024).toFixed(1) + " КБ (лимит 488 КБ)")
  : bad("файл " + (src.length / 1024).toFixed(1) + " КБ — больше лимита 500000 символов");

console.log(fail ? "\nИТОГ: " + fail + " проблем" : "\nИТОГ: чисто");
process.exit(fail ? 1 : 0);
