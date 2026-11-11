/* Прогон всех кадров композиции на заглушке DOM: ищем NaN/undefined в стилях.
   Конфиг: _work/hf_target.json
     {"html": "_out/hyperframes/neon_loop.html", "scenes": ["s1","s2","s3","s4"]}
   Запуск: type sim.cjs | node-real -
   Скриншот file:// в песочнице запрещён, поэтому проверка только численная. */
const fs = require("fs");

let cfg = { html: "_out/hyperframes/neon_loop.html", scenes: null };
try {
  cfg = Object.assign(cfg, JSON.parse(fs.readFileSync("_work/hf_target.json", "utf8")));
} catch (e) {
  console.log("WARN нет _work/hf_target.json, беру " + cfg.html);
}

const src = fs.readFileSync(cfg.html, "utf8");
const code = src.match(/<script>([\s\S]*?)<\/script>/)[1];

/* ---------- заглушка DOM ---------- */
const styleBag = [];
function mkStyle(owner) {
  const o = {};
  return new Proxy(o, {
    set(t, k, v) { t[k] = v; styleBag.push([owner, k, String(v)]); return true; },
    get(t, k) { return t[k] === undefined ? "" : t[k]; }
  });
}

const registry = new Map();
let nodeId = 0;
function mkEl(tag) {
  const el = {
    tagName: (tag || "div").toUpperCase(),
    id: "", className: "", textContent: "",
    children: [], scrollWidth: 4200, scrollHeight: 800,
    addEventListener() {},
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
  };
  el.style = mkStyle(el.id + ":" + (nodeId++) + ":" + el.tagName);
  el.setAttribute = (k, v) => { el[k] = v; };
  el.getAttribute = (k) => el[k];
  return el;
}

const document = {
  activeElement: null,
  body: mkEl("body"),
  getElementById(id) {
    if (!registry.has(id)) { const e = mkEl("div"); e.id = id; registry.set(id, e); }
    return registry.get(id);
  },
  createElement: mkEl,
  querySelector() { return mkEl("div"); },
  addEventListener() {},
};

const location = { search: "", hash: "" };
const windowObj = {
  innerWidth: 1920, innerHeight: 1080,
  addEventListener() {},
  location,
};
const requestAnimationFrame = () => 1;

/* ---------- запуск ---------- */
const runner = new Function(
  "document", "window", "location", "requestAnimationFrame",
  "Math", "console", "Array", "String", "parseFloat", "Date",
  code
);
try {
  runner(document, windowObj, location, requestAnimationFrame, Math, console, Array, String, parseFloat, Date);
} catch (e) {
  console.log("FAIL запуск: " + e.message);
  process.exit(1);
}
console.log("OK  скрипт инициализировался без реального DOM");

const hf = windowObj.__hf;
if (!hf) { console.log("FAIL нет window.__hf"); process.exit(1); }
console.log("OK  window.__hf: duration=" + hf.duration + " fps=" + hf.fps);

const seek = windowObj.__render || hf.seek;
if (typeof seek !== "function") { console.log("FAIL нет window.__render и __hf.seek"); process.exit(1); }

/* ---------- прогон по кадрам ---------- */
const FPS = 60;
const DUR = hf.duration;
let bad = 0;
const seenKeys = new Set();
for (let f = 0; f <= Math.round(DUR * FPS); f++) {
  const t = f / FPS;
  styleBag.length = 0;
  seek(t);
  for (const [owner, k, v] of styleBag) {
    if (/NaN|undefined|Infinity/.test(v)) {
      bad++;
      const key = owner + "." + k;
      if (seenKeys.size < 12 && !seenKeys.has(key)) {
        seenKeys.add(key);
        console.log("   t=" + t.toFixed(3) + " " + key + " = " + v);
      }
    }
  }
}
console.log(Math.round(DUR * FPS) + " кадров проверено");
if (bad) { console.log("FAIL битых значений: " + bad); process.exit(1); }
console.log("OK  ни одного NaN/undefined/Infinity за всё время");

/* ---------- видимость сцен ---------- */
const ids = cfg.scenes && cfg.scenes.length ? cfg.scenes : ["s1", "s2", "s3", "s4"];
const probeTs = [];
for (let t = 0; t <= DUR; t += DUR / 8) probeTs.push(+t.toFixed(2));

const rows = probeTs.map((t) => {
  seek(t);
  const bits = ids.map((id) => {
    const el = registry.get(id);
    return el && el.style.visibility === "visible" ? "1" : "0";
  }).join("");
  return t + "s:" + bits;
});
console.log("OK  видимость сцен " + rows.join("  "));

/* каждая сцена должна быть видна хотя бы на одном пробном кадре */
const dead = ids.filter((id, i) => !rows.some((r) => r.split(":")[1][i] === "1"));
if (dead.length) { console.log("FAIL сцены не появляются: " + dead.join(", ")); process.exit(1); }
console.log("OK  все сцены появляются");
console.log("ГОТОВО");
