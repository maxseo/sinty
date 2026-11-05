/**
 * Settings → Расход. The Web UI loads this in a sandboxed iframe (no token, no network).
 * Charts and the table ask the plugin's JSON routes through the tab/1 postMessage bridge.
 * Theme comes from init.theme (and a later { op: "theme" } if the shell forwards a toggle).
 */
export const TAB_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

export function tabHtml(): string {
  return String.raw`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Расход</title>
<style>
:root {
  color-scheme: light;
  --bg: #f4f4f5; --panel: #fff; --panel-2: #fafafa; --text: #050505; --muted: #71717a;
  --line: rgba(0,0,0,.1); --hover: #f4f4f5; --accent: #74ff2a; --accent-ink: #111;
  --hit: #7dd3fc; --miss: #38bdf8; --plain: #93c5fd; --out: #1d4ed8; --req: #74ff2a;
  --warn: #b45309;
}
[data-theme="dark"] {
  color-scheme: dark;
  --bg: #050505; --panel: #141414; --panel-2: #0a0a0a; --text: #fff; --muted: #a1a1aa;
  --line: rgba(255,255,255,.12); --hover: #1c1c1c; --accent: #74ff2a; --accent-ink: #111;
  --hit: #7dd3fc; --miss: #38bdf8; --plain: #60a5fa; --out: #bfdbfe; --req: #74ff2a;
  --warn: #fbbf24;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 Inter, system-ui, sans-serif; overflow: auto; }
header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-end; padding: 18px 20px 8px; }
h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.02em; }
header p, .muted { color: var(--muted); margin: 0; }
.filters, .views, .kpis, .grid, .panel { margin: 0 20px; }
.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding-bottom: 12px; }
.kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.kpi, .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; }
.kpi { padding: 14px 16px 12px; }
.kpi span, .chart-head b, .panel > b { display: block; color: var(--muted); font-size: 12px; font-weight: 600; }
.kpi b { display: block; margin-top: 4px; font-size: 28px; font-weight: 650; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
.kpi small { color: var(--muted); font-size: 12px; }
.views { display: flex; margin-top: 12px; }
.seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--hover); border: 1px solid var(--line); }
.seg button { border: 0; background: transparent; color: var(--text); border-radius: 999px; padding: 6px 12px; cursor: pointer; font: inherit; }
.seg button.on { background: var(--accent); color: var(--accent-ink); font-weight: 650; }
select, button.ghost { font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 7px 10px; }
button.ghost { cursor: pointer; }
button:disabled { opacity: .45; cursor: default; }
.grid { display: grid; gap: 12px; margin-top: 12px; }
.split { display: grid; grid-template-columns: 1.1fr .9fr; gap: 12px; }
.panel { padding: 12px 14px 14px; }
.chart-head { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-bottom: 4px; }
.chart-head b { color: var(--text); font-size: 14px; }
svg.chart { width: 100%; height: 220px; display: block; }
svg.spark { height: 88px; }
svg text { fill: var(--muted); font-size: 11px; font-family: inherit; }
.grow { transform-box: fill-box; transform-origin: center bottom; animation: rise .55s cubic-bezier(.16,.84,.32,1) both; }
.draw { stroke-dasharray: 2400; stroke-dashoffset: 2400; animation: dash .9s ease forwards; }
@keyframes rise { from { transform: scaleY(.04); opacity: .35; } to { transform: scaleY(1); opacity: 1; } }
@keyframes dash { to { stroke-dashoffset: 0; } }
.legend { display: flex; flex-wrap: wrap; gap: 8px 14px; margin-top: 6px; color: var(--muted); font-size: 12px; }
.legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; vertical-align: baseline; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 8px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; white-space: nowrap; }
th { color: var(--muted); font-size: 12px; font-weight: 600; }
td.num, th.num { text-align: right; }
tr:hover td { background: var(--hover); }
.table-wrap { overflow: auto; }
.share-track { width: 92px; height: 8px; border-radius: 99px; background: var(--line); overflow: hidden; }
.share { height: 8px; border-radius: 99px; background: var(--req); transform-origin: left center; animation: growx .55s cubic-bezier(.16,.84,.32,1) both; }
@keyframes growx { from { transform: scaleX(.05); } to { transform: scaleX(1); } }
.pill { display: inline-block; padding: 1px 7px; border-radius: 99px; background: var(--hover); color: var(--muted); font-size: 11px; margin-left: 6px; }
.pager { display: flex; gap: 8px; align-items: center; padding-top: 10px; }
.err { color: #b91c1c; margin: 8px 20px; }
[data-theme="dark"] .err { color: #fca5a5; }
.empty { margin: 16px 20px; color: var(--muted); }
.tip { position: fixed; z-index: 5; max-width: 280px; padding: 8px 10px; border-radius: 10px; background: var(--text); color: var(--bg); font-size: 12px; white-space: pre-line; pointer-events: none; box-shadow: 0 8px 24px rgba(0,0,0,.18); }
#status { font-size: 12px; text-align: right; }
@media (max-width: 800px) {
  .kpis, .split { grid-template-columns: 1fr; }
  header { flex-direction: column; align-items: flex-start; }
}
</style>
</head>
<body>
<header>
  <div>
    <h1>Расход</h1>
    <p>Запросы и токены моделей из журнала сессий. Доллары — только если провайдер прислал стоимость.</p>
  </div>
  <div id="status" class="muted"></div>
</header>
<div class="filters">
  <div class="seg" id="ranges">
    <button type="button" data-range="today">Сегодня</button>
    <button type="button" data-range="7d" class="on">7 дней</button>
    <button type="button" data-range="30d">30 дней</button>
    <button type="button" data-range="all">Всё</button>
  </div>
  <select id="f-model" aria-label="Модель"><option value="">Все модели</option></select>
  <select id="f-provider" aria-label="Провайдер"><option value="">Все провайдеры</option></select>
  <select id="f-agent" aria-label="Агент"><option value="">Все агенты</option></select>
  <button type="button" class="ghost" id="clear">Сбросить</button>
</div>
<div class="kpis">
  <article class="kpi"><span>Запросы</span><b id="k-req">0</b><small id="k-req-sub">вызовы моделей</small></article>
  <article class="kpi"><span>Токены</span><b id="k-tok">0</b><small id="k-tok-sub">вход и выход</small></article>
  <article class="kpi"><span>Стоимость</span><b id="k-cost">—</b><small id="k-cost-sub">провайдер не прислал USD</small></article>
</div>
<div class="views">
  <div class="seg" id="views">
    <button type="button" data-view="time" class="on">По времени</button>
    <button type="button" data-view="tasks">По задачам</button>
    <button type="button" data-view="calls">По вызовам</button>
  </div>
</div>
<p id="err" class="err"></p>
<p id="empty" class="empty" hidden>Пока нет вызовов за этот период. Новые ходы появятся здесь сами, история подтягивается из журнала при старте.</p>
<div id="data">
<section id="view-time" class="grid">
  <div class="panel">
    <div class="chart-head">
      <div><b id="chart-title">Токены</b><span id="chart-sub" class="muted"></span></div>
      <div class="seg" id="modes">
        <button type="button" data-mode="parts" class="on">Состав</button>
        <button type="button" data-mode="model">Модель</button>
      </div>
    </div>
    <svg id="chart-main" class="chart" role="img" aria-label="Токены по времени"></svg>
    <div id="legend" class="legend"></div>
  </div>
  <div class="split">
    <div class="panel"><b>Запросы</b><svg id="chart-req" class="chart" role="img" aria-label="Запросы по времени"></svg></div>
    <div class="panel"><b id="side-title">По моделям</b><svg id="chart-side" class="chart" role="img" aria-label="Второй график"></svg></div>
  </div>
</section>
<section id="view-tasks" class="grid" hidden>
  <div class="panel table-wrap">
    <table>
      <thead><tr><th>Задача</th><th>Агент</th><th class="num">Запросы</th><th class="num">Вход</th><th class="num">Выход</th><th class="num">Токены</th><th>Доля</th></tr></thead>
      <tbody id="task-rows"></tbody>
    </table>
  </div>
</section>
<section id="view-calls" class="grid" hidden>
  <div class="panel"><b>Запросы</b><svg id="chart-calls" class="chart spark" role="img" aria-label="Запросы"></svg></div>
  <div class="panel table-wrap">
    <table>
      <thead id="call-head"></thead>
      <tbody id="call-rows"></tbody>
    </table>
    <div class="pager">
      <button type="button" class="ghost" id="prev">Назад</button>
      <span id="page-label" class="muted"></span>
      <button type="button" class="ghost" id="next">Дальше</button>
    </div>
  </div>
</section>
</div>
<div id="tip" class="tip" hidden></div>
<script>
(function () {
  var NS = "http://www.w3.org/2000/svg";
  var PAGE = 40;
  var fmt = new Intl.NumberFormat("ru-RU");
  var state = { range: "7d", view: "time", mode: "parts", page: 0, booted: false };
  var loadGen = 0;
  var n = 0;
  var wait = new Map();
  var summary = null;
  var series = null;
  var tasks = [];
  var calls = { total: 0, items: [] };
  var hasCost = false;

  function byId(id) {
    var node = document.getElementById(id);
    if (!node) throw new Error("missing " + id);
    return node;
  }
  function send(op, extra) {
    var msg = { sinty: "tab/1", op: op };
    if (extra) Object.assign(msg, extra);
    parent.postMessage(msg, "*");
  }
  function ask(op, path) {
    var id = ++n;
    return new Promise(function (ok) { wait.set(id, ok); send(op, { id: id, path: path }); });
  }
  addEventListener("message", function (e) {
    var m = e.data || {};
    if (m.sinty !== "tab/1") return;
    if ((m.op === "init" || m.op === "theme") && m.theme) document.documentElement.dataset.theme = m.theme;
    if (m.op === "init" && !state.booted) { state.booted = true; reload(); poll(); }
    if (typeof m.id === "number" && wait.has(m.id)) { var fn = wait.get(m.id); wait.delete(m.id); fn(m); }
  });

  function num(v) { return fmt.format(Math.round(v || 0)); }
  function money(v) {
    if (v == null || !isFinite(v)) return "—";
    return v.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + " USD";
  }
  function when(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return ts || "";
    return d.toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function clock(ms) {
    if (ms == null || !isFinite(ms)) return "—";
    if (ms < 1000) return Math.round(ms) + " мс";
    if (ms < 60000) return (ms / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " с";
    var s = Math.round(ms / 1000);
    return Math.floor(s / 60) + " мин " + (s % 60) + " с";
  }
  function speed(row) {
    if (!row.durationMs) return "—";
    var per = row.outputTokens / (row.durationMs / 1000);
    if (!isFinite(per) || per <= 0) return "—";
    return num(per) + " ток/с";
  }
  function startOfToday() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  function rangeFrom() {
    if (state.range === "all") return "";
    if (state.range === "today") return startOfToday();
    var days = state.range === "30d" ? 30 : 7;
    return new Date(Date.now() - days * 86400000).toISOString();
  }
  function qs() {
    var parts = [];
    var from = rangeFrom();
    if (from) parts.push("from=" + encodeURIComponent(from));
    var model = byId("f-model").value;
    var provider = byId("f-provider").value;
    var agent = byId("f-agent").value;
    if (model) parts.push("model=" + encodeURIComponent(model));
    if (provider) parts.push("provider=" + encodeURIComponent(provider));
    if (agent) parts.push("agent=" + encodeURIComponent(agent));
    return parts.join("&");
  }
  function fail(m) {
    byId("err").textContent = (m && m.error && m.error.message) || "Не удалось прочитать расход.";
  }

  function fillSelect(id, rows, all) {
    var sel = byId(id);
    var cur = sel.value;
    sel.replaceChildren();
    var first = document.createElement("option");
    first.value = "";
    first.textContent = all;
    sel.appendChild(first);
    for (var i = 0; i < rows.length; i++) {
      var o = document.createElement("option");
      o.value = rows[i].value;
      o.textContent = rows[i].label;
      sel.appendChild(o);
    }
    var keep = false;
    for (var j = 0; j < sel.options.length; j++) if (sel.options[j].value === cur) keep = true;
    sel.value = keep ? cur : "";
  }

  function svgEl(name) { return document.createElementNS(NS, name); }
  function showTip(text, ev) {
    var tip = byId("tip");
    tip.hidden = false;
    tip.textContent = text;
    tip.style.left = Math.min(ev.clientX + 14, window.innerWidth - 300) + "px";
    tip.style.top = (ev.clientY + 14) + "px";
  }
  function hideTip() { byId("tip").hidden = true; }

  function pointText(p, lines) {
    var out = [p.label, "Запросы: " + num(p.requests), "Токены: " + num(p.totalTokens)];
    for (var i = 0; i < lines.length; i++) {
      var v = lines[i].pick(p);
      if (v) out.push(lines[i].name + ": " + num(v));
    }
    if (p.costUsd != null) out.push(money(p.costUsd));
    return out.join("\n");
  }

  function drawStacked(svg, points, layers) {
    svg.replaceChildren();
    var W = 720, H = 200, left = 44, right = 8, top = 14, bottom = 26;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    if (!points.length) return;
    var max = 1;
    for (var i = 0; i < points.length; i++) {
      var sum = 0;
      for (var j = 0; j < layers.length; j++) sum += Number(layers[j].pick(points[i])) || 0;
      if (sum > max) max = sum;
    }
    var plotW = W - left - right;
    var plotH = H - top - bottom;
    var slot = plotW / points.length;
    var bw = Math.max(1, slot * 0.62);
    var every = Math.ceil(points.length / 8);
    var axis = svgEl("text");
    axis.setAttribute("x", "4");
    axis.setAttribute("y", "12");
    axis.textContent = num(max);
    svg.appendChild(axis);
    for (var n = 0; n < points.length; n++) {
      var y = top + plotH;
      var x = left + n * slot + (slot - bw) / 2;
      for (var k = layers.length - 1; k >= 0; k--) {
        var v = Number(layers[k].pick(points[n])) || 0;
        var h = v / max * plotH;
        if (h < 0.4) continue;
        y -= h;
        var rect = svgEl("rect");
        rect.setAttribute("x", x.toFixed(2));
        rect.setAttribute("y", y.toFixed(2));
        rect.setAttribute("width", bw.toFixed(2));
        rect.setAttribute("height", h.toFixed(2));
        rect.setAttribute("rx", "2");
        rect.setAttribute("fill", layers[k].color);
        rect.setAttribute("class", "grow");
        rect.style.animationDelay = (n * 16) + "ms";
        (function (text) {
          rect.addEventListener("mousemove", function (ev) { showTip(text, ev); });
        })(pointText(points[n], layers));
        svg.appendChild(rect);
      }
      if (n % every === 0) {
        var label = svgEl("text");
        label.setAttribute("x", String(left + n * slot));
        label.setAttribute("y", String(H - 8));
        label.textContent = points[n].label;
        svg.appendChild(label);
      }
    }
  }

  function drawArea(svg, points) {
    svg.replaceChildren();
    var W = 720, H = 200, left = 44, right = 8, top = 14, bottom = 26;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    if (!points.length) return;
    var max = 1;
    for (var i = 0; i < points.length; i++) if (points[i].requests > max) max = points[i].requests;
    var plotW = W - left - right;
    var plotH = H - top - bottom;
    var coords = [];
    for (var n = 0; n < points.length; n++) {
      var x = left + (points.length === 1 ? plotW / 2 : (n / (points.length - 1)) * plotW);
      var y = top + plotH - (points[n].requests / max) * plotH;
      coords.push(x.toFixed(2) + "," + y.toFixed(2));
    }
    var base = (top + plotH).toFixed(2);
    var d = "M" + coords[0] + " L" + coords.join(" L") + " L" + coords[coords.length - 1].split(",")[0] + "," + base + " L" + coords[0].split(",")[0] + "," + base + " Z";
    var fill = svgEl("path");
    fill.setAttribute("d", d);
    fill.setAttribute("fill", "var(--req)");
    fill.setAttribute("fill-opacity", "0.28");
    fill.setAttribute("class", "grow");
    svg.appendChild(fill);
    var line = svgEl("path");
    line.setAttribute("d", "M" + coords.join(" L"));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "var(--req)");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("class", "draw");
    svg.appendChild(line);
    var every = Math.ceil(points.length / 8);
    for (var p = 0; p < points.length; p++) {
      if (p % every !== 0) continue;
      var label = svgEl("text");
      var x = left + (points.length === 1 ? plotW / 2 : (p / (points.length - 1)) * plotW);
      label.setAttribute("x", String(x));
      label.setAttribute("y", String(H - 8));
      label.textContent = points[p].label;
      svg.appendChild(label);
    }
    svg.__points = points;
    if (svg.dataset.area) return;
    svg.dataset.area = "1";
    svg.addEventListener("mousemove", function (ev) {
      var pts = svg.__points || [];
      if (!pts.length) return;
      var rect = svg.getBoundingClientRect();
      var ratio = rect.width ? (ev.clientX - rect.left) / rect.width : 0;
      var idx = Math.max(0, Math.min(pts.length - 1, Math.round(ratio * (pts.length - 1))));
      showTip(pointText(pts[idx], []), ev);
    });
  }

  var MODEL_COLORS = ["#f97316", "#3b82f6", "#22c55e", "#a855f7", "#eab308", "#94a3b8"];
  function partLayers() {
    var layers = [];
    if (series && series.hasCache) {
      layers.push({ name: "Кэш", color: "var(--hit)", pick: function (p) { return p.hit; } });
      layers.push({ name: "Мимо кэша", color: "var(--miss)", pick: function (p) { return p.miss; } });
    }
    layers.push({ name: "Вход", color: "var(--plain)", pick: function (p) { return p.plain; } });
    layers.push({ name: "Выход", color: "var(--out)", pick: function (p) { return p.outputTokens; } });
    return layers;
  }
  function modelLayers() {
    var models = (series && series.models) || [];
    return models.map(function (m, i) {
      return { name: m.model, color: MODEL_COLORS[i % MODEL_COLORS.length], pick: function (p) { return m.values[series.points.indexOf(p)] || 0; } };
    });
  }

  function paint() {
    var points = (series && series.points) || [];
    var parts = partLayers();
    var models = modelLayers();
    var mainLayers = state.mode === "model" ? models : parts;
    var sideLayers = state.mode === "model" ? parts : models;
    byId("chart-title").textContent = state.mode === "model" ? "Токены по моделям" : "Токены";
    byId("side-title").textContent = state.mode === "model" ? "Состав" : "По моделям";
    var sub = series && series.chartTruncated ? "Показан хвост длинного периода." : "";
    if (series && series.truncated) sub = (sub ? sub + " " : "") + "Индекс обрезан по последним записям фильтра.";
    byId("chart-sub").textContent = sub;
    drawStacked(byId("chart-main"), points, mainLayers.length ? mainLayers : parts);
    drawArea(byId("chart-req"), points);
    drawStacked(byId("chart-side"), points, sideLayers.length ? sideLayers : parts);
    drawStacked(byId("chart-calls"), points, [{ name: "Запросы", color: "var(--req)", pick: function (p) { return p.requests; } }]);
    var legendLayers = (mainLayers.length ? mainLayers : parts).filter(function (layer) {
      var sum = 0;
      for (var i = 0; i < points.length; i++) sum += Number(layer.pick(points[i])) || 0;
      return sum > 0;
    });
    var legendEl = byId("legend");
    legendEl.replaceChildren();
    for (var i = 0; i < legendLayers.length; i++) {
      var item = document.createElement("span");
      var sw = document.createElement("i");
      sw.style.background = legendLayers[i].color;
      item.appendChild(sw);
      item.appendChild(document.createTextNode(legendLayers[i].name));
      legendEl.appendChild(item);
    }
  }

  function paintKpis() {
    var s = summary || { requests: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, hasCache: false, hasCost: false, costUsd: null, pricedCalls: 0 };
    tween(byId("k-req"), s.requests);
    tween(byId("k-tok"), s.totalTokens);
    var bits = ["вход " + num(s.inputTokens), "выход " + num(s.outputTokens)];
    if (s.hasCache) bits.push("кэш " + num(s.cachedTokens));
    byId("k-tok-sub").textContent = bits.join(" · ");
    byId("k-cost").textContent = s.hasCost ? money(s.costUsd) : "—";
    byId("k-cost-sub").textContent = s.hasCost ? ("есть цена у " + num(s.pricedCalls) + " из " + num(s.requests)) : "провайдер не прислал USD";
    hasCost = !!s.hasCost;
  }
  function tween(el, to) {
    if (!window.requestAnimationFrame || !window.performance) { el.textContent = num(to); el.dataset.n = String(to); return; }
    var from = Number(el.dataset.n || 0);
    var t0 = performance.now();
    function step(now) {
      var k = Math.min(1, (now - t0) / 520);
      var eased = 1 - Math.pow(1 - k, 3);
      var v = Math.round(from + (to - from) * eased);
      el.textContent = num(v);
      el.dataset.n = String(v);
      if (k < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function paintTasks() {
    var body = byId("task-rows");
    body.replaceChildren();
    var max = 1;
    for (var i = 0; i < tasks.length; i++) if (tasks[i].totalTokens > max) max = tasks[i].totalTokens;
    for (var r = 0; r < tasks.length; r++) {
      var t = tasks[r];
      var tr = document.createElement("tr");
      var title = document.createElement("td");
      title.textContent = t.title || t.sessionId;
      if (t.sessionKind === "task") {
        var pill = document.createElement("span");
        pill.className = "pill";
        pill.textContent = "задача";
        title.appendChild(pill);
      }
      var agent = document.createElement("td");
      agent.textContent = t.agentName || "—";
      tr.append(title, agent, cell(num(t.requests), true), cell(num(t.inputTokens), true), cell(num(t.outputTokens), true), cell(num(t.totalTokens), true));
      var share = document.createElement("td");
      var track = document.createElement("div");
      track.className = "share-track";
      var bar = document.createElement("div");
      bar.className = "share";
      bar.style.width = Math.max(4, Math.round((t.totalTokens / max) * 100)) + "%";
      track.appendChild(bar);
      share.appendChild(track);
      tr.appendChild(share);
      body.appendChild(tr);
    }
  }
  function cell(text, numeric) {
    var td = document.createElement("td");
    td.textContent = text;
    if (numeric) td.className = "num";
    return td;
  }
  function paintCalls() {
    var head = byId("call-head");
    var cols = ["Дата", "Модель", "Провайдер", "Задача", "Агент", "Вход", "Кэш", "Выход", "Токены"];
    if (hasCost) cols.push("Стоимость");
    cols.push("Время", "Скорость", "Причина");
    var hr = document.createElement("tr");
    for (var c = 0; c < cols.length; c++) {
      var th = document.createElement("th");
      th.textContent = cols[c];
      if (c >= 5) th.className = "num";
      hr.appendChild(th);
    }
    head.replaceChildren(hr);
    var body = byId("call-rows");
    body.replaceChildren();
    var items = calls.items || [];
    for (var i = 0; i < items.length; i++) {
      var row = items[i];
      var tr = document.createElement("tr");
      var values = [when(row.ts), row.model || "—", row.provider || "—", row.sessionTitle || row.sessionId, row.source === "plugin" ? ("плагин " + (row.plugin || row.agentName || "")) : (row.agentName || "—"), num(row.inputTokens), row.cachedTokens == null ? "—" : num(row.cachedTokens), num(row.outputTokens), num(row.inputTokens + row.outputTokens)];
      if (hasCost) values.push(row.costUsd == null ? "—" : money(row.costUsd));
      values.push(clock(row.durationMs), speed(row), row.stopReason || "—");
      for (var k = 0; k < values.length; k++) tr.appendChild(cell(values[k], k >= 5));
      if (row.cacheMissTokens != null) tr.title = "Мимо кэша: " + num(row.cacheMissTokens);
      body.appendChild(tr);
    }
    var pages = Math.max(1, Math.ceil((calls.total || 0) / PAGE));
    byId("page-label").textContent = (state.page + 1) + " / " + pages + " · " + num(calls.total || 0);
    byId("prev").disabled = state.page <= 0;
    byId("next").disabled = (state.page + 1) * PAGE >= (calls.total || 0);
  }

  function showView() {
    byId("view-time").hidden = state.view !== "time";
    byId("view-tasks").hidden = state.view !== "tasks";
    byId("view-calls").hidden = state.view !== "calls";
    var buttons = byId("views").querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) buttons[i].classList.toggle("on", buttons[i].dataset.view === state.view);
  }

  async function reload() {
    var gen = ++loadGen;
    byId("err").textContent = "";
    var q = qs();
    var tz = new Date().getTimezoneOffset();
    var statusM = await ask("get", "/status");
    if (gen !== loadGen) return;
    if (statusM.ok && statusM.data) {
      var st = statusM.data;
      var line = num(st.calls) + " в индексе";
      if (st.backfill === "running") line += " · читаю журнал";
      else if (st.backfill === "error") line += " · " + (st.error || "журнал не прочитан");
      if (st.retainDays) line += " · хранить " + st.retainDays + " дн.";
      byId("status").textContent = line;
    }
    var summaryM = await ask("get", "/summary?" + q);
    if (gen !== loadGen) return;
    if (!summaryM.ok) { fail(summaryM); return; }
    var seriesM = await ask("get", "/series?" + q + (q ? "&" : "") + "tz=" + encodeURIComponent(String(tz)));
    if (gen !== loadGen) return;
    if (!seriesM.ok) { fail(seriesM); return; }
    var facetQ = rangeFrom();
    var facetsM = await ask("get", "/facets" + (facetQ ? "?from=" + encodeURIComponent(facetQ) : ""));
    if (gen !== loadGen) return;
    if (facetsM.ok && facetsM.data) {
      var f = facetsM.data;
      fillSelect("f-model", (f.models || []).map(function (m) { return { value: m, label: m }; }), "Все модели");
      fillSelect("f-provider", (f.providers || []).map(function (m) { return { value: m, label: m }; }), "Все провайдеры");
      fillSelect("f-agent", (f.agents || []).map(function (a) { return { value: a.id || a.name, label: a.name || a.id }; }), "Все агенты");
    }
    var extra = { ok: true, data: {} };
    if (state.view === "tasks") extra = await ask("get", "/tasks?" + q);
    if (state.view === "calls") extra = await ask("get", "/calls?" + q + (q ? "&" : "") + "limit=" + PAGE + "&offset=" + (state.page * PAGE));
    if (gen !== loadGen) return;
    if (!extra.ok) { fail(extra); return; }
    summary = summaryM.data;
    series = seriesM.data;
    tasks = (extra.data && extra.data.items) || [];
    calls = state.view === "calls" ? (extra.data || { total: 0, items: [] }) : calls;
    var empty = !summary || !summary.requests;
    byId("empty").hidden = !empty;
    byId("data").hidden = !!empty;
    paintKpis();
    if (!empty) { paint(); paintTasks(); paintCalls(); }
    showView();
  }

  function poll() {
    setInterval(function () {
      if (document.visibilityState === "hidden") return;
      reload();
    }, 20000);
  }

  byId("ranges").addEventListener("click", function (ev) {
    var btn = ev.target.closest("button");
    if (!btn) return;
    state.range = btn.dataset.range;
    state.page = 0;
    var all = byId("ranges").querySelectorAll("button");
    for (var i = 0; i < all.length; i++) all[i].classList.toggle("on", all[i] === btn);
    reload();
  });
  byId("views").addEventListener("click", function (ev) {
    var btn = ev.target.closest("button");
    if (!btn) return;
    state.view = btn.dataset.view;
    state.page = 0;
    showView();
    reload();
  });
  byId("modes").addEventListener("click", function (ev) {
    var btn = ev.target.closest("button");
    if (!btn || !series) return;
    state.mode = btn.dataset.mode;
    var all = byId("modes").querySelectorAll("button");
    for (var i = 0; i < all.length; i++) all[i].classList.toggle("on", all[i] === btn);
    paint();
  });
  byId("f-model").addEventListener("change", function () { state.page = 0; reload(); });
  byId("f-provider").addEventListener("change", function () { state.page = 0; reload(); });
  byId("f-agent").addEventListener("change", function () { state.page = 0; reload(); });
  byId("clear").addEventListener("click", function () {
    byId("f-model").value = "";
    byId("f-provider").value = "";
    byId("f-agent").value = "";
    state.range = "7d";
    state.page = 0;
    var all = byId("ranges").querySelectorAll("button");
    for (var i = 0; i < all.length; i++) all[i].classList.toggle("on", all[i].dataset.range === "7d");
    reload();
  });
  byId("prev").addEventListener("click", function () { if (state.page > 0) { state.page--; reload(); } });
  byId("next").addEventListener("click", function () { state.page++; reload(); });
  ["chart-main", "chart-req", "chart-side", "chart-calls"].forEach(function (id) {
    byId(id).addEventListener("mouseleave", hideTip);
  });
  send("ready");
})();
</script>
</body>
</html>`;
}
