/**
 * The tab page. The Web UI loads it in `<iframe sandbox="allow-scripts">` (opaque origin): it has no token and, with
 * this CSP, no network at all. Data comes only from the UI's postMessage bridge ({ sinty: "tab/1", op: "get" }),
 * which forwards GETs to this plugin's own routes. All data is rendered with textContent, never as HTML.
 * The tab sits in an open chat's header (manifest placement "session"): the bridge sends the chat's id in `init` and
 * `{ op: "session" }` on every switch, and the page only ever shows that one chat.
 */
export const TAB_CSP = ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "img-src data:", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"].join("; ");

export const TAB_HTML = String.raw`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Context inspector</title>
<style>
:root { --bg:#fff; --fg:#1d1d1f; --muted:#6e6e73; --line:#e5e5ea; --soft:#f5f5f7; --accent:#3a5bd9; --warn:#b54708; }
:root[data-theme=dark] { --bg:#16161a; --fg:#ececf1; --muted:#9a9aa5; --line:#2c2c33; --soft:#1f1f25; --accent:#8ea2ff; --warn:#f5a524; }
* { box-sizing:border-box; }
body { margin:0; font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--fg); background:var(--bg); }
.top { display:flex; gap:12px; align-items:center; padding:10px 14px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:2; }
.top h1 { font-size:14px; margin:0 8px 0 0; }
select, button { font:inherit; color:inherit; background:var(--soft); border:1px solid var(--line); border-radius:6px; padding:3px 8px; }
.wrap { display:grid; grid-template-columns:220px 1fr; min-height:calc(100vh - 46px); }
.wrap.none { display:block; }
.wrap.none .steps { display:none; }
@media (max-width: 720px) { .wrap { grid-template-columns:1fr; } .steps { max-height:180px; border-right:0; border-bottom:1px solid var(--line); } }
.steps { border-right:1px solid var(--line); overflow:auto; max-height:calc(100vh - 46px); }
.turn { padding:6px 12px 2px; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
.step { display:block; width:100%; text-align:left; border:0; border-radius:0; background:none; padding:6px 12px; cursor:pointer; }
.step:hover { background:var(--soft); }
.step.on { background:var(--soft); box-shadow:inset 3px 0 0 var(--accent); }
.step .t { font-variant-numeric:tabular-nums; color:var(--muted); font-size:11px; }
.main { padding:14px 18px 40px; overflow:auto; max-height:calc(100vh - 46px); }
.cards { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px; }
.card { border:1px solid var(--line); border-radius:8px; padding:8px 12px; min-width:110px; }
.card b { display:block; font-size:18px; font-variant-numeric:tabular-nums; }
.card span { color:var(--muted); font-size:11px; }
.bar { display:flex; height:14px; border-radius:7px; overflow:hidden; background:var(--soft); margin:6px 0 6px; }
.bar i { display:block; height:100%; }
.legend { display:flex; gap:12px; flex-wrap:wrap; font-size:12px; color:var(--muted); margin-bottom:14px; }
.legend i { display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:4px; vertical-align:middle; }
h2 { font-size:13px; margin:18px 0 6px; }
table { border-collapse:collapse; width:100%; }
th, td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:500; font-size:11px; }
td.n { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
tr.part { cursor:pointer; }
tr.part:hover td { background:var(--soft); }
pre { margin:0; white-space:pre-wrap; word-break:break-word; font:12px/1.4 ui-monospace,Menlo,Consolas,monospace; background:var(--soft); padding:8px; border-radius:6px; max-height:420px; overflow:auto; }
.kind { display:inline-block; padding:0 6px; border-radius:4px; font-size:11px; color:#fff; }
.muted { color:var(--muted); }
.warn { color:var(--warn); }
.empty { padding:40px; color:var(--muted); max-width:560px; }
.empty b { display:block; color:var(--fg); font-size:14px; margin-bottom:6px; }
.delta { font-size:11px; margin-left:4px; }
.add { color:#1a7f37; } .rem { color:#cf222e; }
tr.cut td { border-bottom:2px dashed var(--accent); color:var(--accent); font-size:11px; padding:2px 8px; }
tr.div td { border-bottom:2px dashed var(--warn); color:var(--warn); font-size:11px; padding:2px 8px; }
.card.fact { border-color:var(--accent); }
.card.win { display:flex; gap:10px; align-items:center; }
.card.win svg { flex:none; }
.card.win .pct { font-size:12px; font-weight:600; fill:var(--fg); }
</style>
</head>
<body>
<div class="top">
  <h1>Контекст чата</h1>
  <span id="status" class="muted"></span>
  <span style="flex:1"></span>
  <label class="muted" title="Каждые 3 с; новый шаг открывается сам, если выбран последний"><input type="checkbox" id="live" checked> обновлять</label>
</div>
<div class="wrap none" id="wrap">
  <div class="steps" id="steps"></div>
  <div class="main" id="main"></div>
</div>
<script>
(function () {
  "use strict";
  var PROTO = "tab/1";
  var COLORS = { system: "#5b6abf", skills: "#7c8b9a", memory: "#2e9d6a", summary: "#c08a1d", recall: "#1f8fb3", processor: "#b04fbf", plugin: "#d0573a", dialogue: "#8a8f98", turn: "#1f8fb3" };
  var NAMES = { system: "системный", skills: "навыки", memory: "память", summary: "сводка", recall: "recall", processor: "процессор", plugin: "плагин", dialogue: "диалог", turn: "контекст хода" };
  var SOURCES = { config: "memory.contextTokens", route: "models.contextWindows", provider: "по списку моделей провайдера", table: "по таблице Sinty", fallback: "по умолчанию: модель неизвестна" };
  var HINTS = { static: "инструменты, системный промпт, навыки", session: "память сессии и сводка (до компакции)", turn: "диалог до этого места" };
  var seq = 0, pending = {}, state = { session: "", step: "", list: [], snap: null, open: {} }, epoch = 0, inited = false;

  function get(path) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      parent.postMessage({ sinty: PROTO, id: id, op: "get", path: path }, "*");
      setTimeout(function () { if (pending[id]) { delete pending[id]; reject(new Error("timeout")); } }, 15000);
    });
  }
  addEventListener("message", function (e) {
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || m.sinty !== PROTO) return;
    if (m.op === "init") { inited = true; document.documentElement.dataset.theme = m.theme === "dark" ? "dark" : "light"; setSession(m.sessionId); return; }
    if (m.op === "session") { setSession(m.sessionId); return; }
    var p = pending[m.id];
    if (!p) return;
    delete pending[m.id];
    if (m.ok) p.resolve(m.data); else p.reject(new Error((m.error && m.error.message) || "error"));
  });

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === "text") n.textContent = attrs[k]; else if (k === "class") n.className = attrs[k]; else if (k === "style") n.setAttribute("style", attrs[k]); else n.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function fmt(n) { return n >= 1000000 ? Number((n / 1000000).toFixed(2)) + "M" : n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(n); }
  function pct(a, b) { return b ? Math.round(100 * a / b) + "%" : "—"; }
  function time(iso) { var d = new Date(iso); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  function badge(kind) { return el("span", { class: "kind", style: "background:" + (COLORS[kind] || "#888"), text: NAMES[kind] || kind }); }
  function status(t) { document.getElementById("status").textContent = t; }

  function setSession(id) {
    epoch++;
    state = { session: typeof id === "string" ? id : "", step: "", list: [], snap: null, open: {} };
    document.getElementById("steps").textContent = "";
    if (!state.session) { empty("Чат не открыт", "Вкладка показывает контекст открытого чата. Откройте чат слева."); status(""); return; }
    empty("Загрузка…", "");
    refresh();
  }

  function empty(title, text) {
    document.getElementById("wrap").className = "wrap none";
    var main = document.getElementById("main");
    main.textContent = "";
    main.appendChild(el("div", { class: "empty" }, [el("b", { text: title }), text]));
  }

  function refresh() {
    if (!state.session) return Promise.resolve();
    var my = epoch;
    return get("/snapshots?session=" + encodeURIComponent(state.session)).then(function (l) {
      if (my !== epoch) return;
      var list = l.snapshots || [];
      if (!list.length) {
        state.list = []; state.step = ""; state.snap = null;
        document.getElementById("steps").textContent = "";
        status("снимков нет");
        empty("Для этого чата снимков пока нет", "Снимки появляются начиная со следующего сообщения: на каждом шаге модели плагин запоминает, что ушло в промпт. Хранятся только в памяти, с момента запуска Sinty, поэтому у старых сообщений и после перезапуска их нет.");
        return;
      }
      var newest = list[list.length - 1].id;
      var follow = !state.step || !list.some(function (s) { return s.id === state.step; }) || (state.list.length && state.step === state.list[state.list.length - 1].id);
      state.list = list;
      if (follow) state.step = newest;
      document.getElementById("wrap").className = "wrap";
      drawSteps();
      var turns = {}; list.forEach(function (s) { turns[s.turnId] = 1; });
      status(Object.keys(turns).length + " ход(ов) · " + list.length + " шаг(ов)");
      if (!state.snap || state.snap.id !== state.step) return open(state.step);
    }).catch(function (e) { if (my === epoch) status("ошибка: " + e.message); });
  }

  function drawSteps() {
    var box = document.getElementById("steps");
    box.textContent = "";
    var lastTurn = "", turnNo = 0;
    state.list.forEach(function (s, i) {
      if (s.turnId !== lastTurn) { lastTurn = s.turnId; turnNo++; box.appendChild(el("div", { class: "turn", text: "Ход " + turnNo })); }
      var prev = i > 0 ? state.list[i - 1] : null;
      var d = prev ? s.tokens.total - prev.tokens.total : 0;
      var b = el("button", { class: "step" + (s.id === state.step ? " on" : "") }, [
        el("div", {}, ["Шаг " + s.step + " · " + fmt(s.tokens.total) + " ток.", d ? el("span", { class: "delta " + (d > 0 ? "add" : "rem"), text: (d > 0 ? "+" : "") + fmt(d) }) : null]),
        el("div", { class: "t", text: time(s.at) + (s.route ? " · " + s.route : "") + (s.usage ? " · кэш " + pct(s.usage.cachedTokens || 0, s.usage.inputTokens) : "") + (s.redactions ? " · скрыто " + s.redactions : "") }),
      ]);
      b.addEventListener("click", function () { state.step = s.id; drawSteps(); open(s.id); });
      box.appendChild(b);
    });
  }

  function open(id) {
    var my = epoch;
    return get("/snapshots/" + encodeURIComponent(id)).then(function (snap) {
      if (my !== epoch || state.step !== id) return;
      state.snap = snap;
      draw(snap);
    }).catch(function (e) { if (my === epoch) status("ошибка: " + e.message); });
  }

  function table(head, rows) {
    return el("table", {}, [el("tr", {}, head.map(function (h) { return el("th", { text: h }); }))].concat(rows));
  }

  function draw(s) {
    var main = document.getElementById("main");
    main.textContent = "";
    main.appendChild(el("div", { class: "cards" }, [
      windowCard(s),
      card(fmt(s.tokens.total), "токенов всего (оценка)"),
      card(fmt(s.tokens.messages), "сообщения"),
      card(fmt(s.tokens.tools), "схемы " + s.tools.length + " инструм."),
      card(String(s.messages.length), "сообщений"),
      card(String(s.memory.facts.length), "фактов в памяти"),
      card(String(s.memory.recall ? s.memory.recall.records.length : 0), "recall"),
      s.redactions ? card(String(s.redactions), "строк со скрытыми секретами") : null,
    ]));
    // Prompt cache: what the provider reported (usage.recorded) next to the core's estimates.
    var u = s.usage, c = s.cache;
    main.appendChild(el("div", { class: "cards" }, [
      u ? card(fmt(u.inputTokens), "вход, факт (" + u.provider + ")", "fact") : card("…", "факт: ждём ответа модели"),
      u ? card(fmt(u.cachedTokens || 0) + " · " + pct(u.cachedTokens || 0, u.inputTokens), "из кэша, факт", "fact") : null,
      u && u.cacheMissTokens !== undefined ? card(fmt(u.cacheMissTokens), "мимо кэша, факт", "fact") : null,
      u && u.cacheWriteTokens ? card(fmt(u.cacheWriteTokens), "записано в кэш, факт", "fact") : null,
      u ? card(fmt(u.outputTokens), "выход, факт", "fact") : null,
      c ? card(fmt(c.cacheable.tokens), "кэшируемый префикс (оценка)") : null,
      c && c.reused ? card(fmt(c.reused.tokens), "совпало с прошлым шагом (оценка)" + (c.reused.toolsSame ? "" : ", инструменты изменились")) : null,
    ]));
    var kinds = Object.keys(s.tokens.byKind);
    var bar = el("div", { class: "bar" });
    var legend = el("div", { class: "legend" });
    kinds.forEach(function (k) {
      var v = s.tokens.byKind[k];
      bar.appendChild(el("i", { style: "width:" + (100 * v / Math.max(1, s.tokens.messages)) + "%;background:" + COLORS[k], title: k + " " + v }));
      legend.appendChild(el("span", {}, [el("i", { style: "background:" + COLORS[k] }), (NAMES[k] || k) + " " + fmt(v)]));
    });
    main.appendChild(bar);
    main.appendChild(legend);
    if (s.persona) main.appendChild(el("div", { class: s.persona.source === "global" && !s.persona.agentName ? "warn" : "muted", text: personaText(s.persona) }));
    main.appendChild(el("div", { class: "muted", text: "Сессия " + s.sessionId + " · ход " + s.turnId + " · шаг " + s.step + " (" + s.stepId + ") · агент " + s.agentId + " · " + new Date(s.at).toLocaleString() }));

    main.appendChild(el("h2", { text: "Что ушло в модель (" + s.parts.length + " сообщений, по порядку)" }));
    var rows = [];
    s.parts.forEach(function (p) {
      var m = s.messages[p.index] || {};
      var preview = (m.content || (m.toolCalls ? "[вызов " + m.toolCalls.map(function (c) { return c.name; }).join(", ") + "]" : "")).replace(/\s+/g, " ").slice(0, 120);
      var tr = el("tr", { class: "part" }, [
        el("td", { class: "n", text: String(p.index) }),
        el("td", {}, [badge(p.kind)]),
        el("td", { text: p.source + (p.id ? " · " + p.id : "") + (p.blocks && p.blocks.length ? " [" + p.blocks.join(", ") + "]" : "") + (p.untrusted ? " · untrusted" : "") }),
        el("td", { text: m.role || "" }),
        el("td", { class: "muted", text: preview }),
        el("td", { class: "n", text: fmt(p.tokens) }),
      ]);
      var key = s.id + ":" + p.index;
      var detail = el("tr", { style: state.open[key] ? "" : "display:none" }, [el("td", { colspan: "6" }, [el("pre", { text: (m.content || "") + (m.toolCalls ? "\n\n" + JSON.stringify(m.toolCalls, null, 2) : "") + (m.toolCallId ? "\n\n[toolCallId " + m.toolCallId + "]" : "") })])]);
      tr.addEventListener("click", function () { state.open[key] = !state.open[key]; detail.style.display = state.open[key] ? "" : "none"; });
      if (s.cache && s.cache.reused && s.cache.reused.divergedAt === p.index) rows.push(el("tr", { class: "div" }, [el("td", { colspan: "6", text: "▼ отсюда промпт отличается от прошлого шага: дальше кэш не читается" })]));
      rows.push(tr, detail);
      if (p.cacheHint) rows.push(el("tr", { class: "cut" }, [el("td", { colspan: "6", text: "▲ граница кэша «" + p.cacheHint + "»: " + (HINTS[p.cacheHint] || "") })]));
    });
    main.appendChild(table(["#", "часть", "источник", "роль", "начало", "ток."], rows));

    main.appendChild(el("h2", { text: "Память: факты в блоке memory.profile (" + s.memory.facts.length + ")" }));
    main.appendChild(s.memory.facts.length ? table(["tier", "scope", "источник", "текст", "создан"], s.memory.facts.map(function (f) {
      return el("tr", {}, [el("td", { text: f.tier }), el("td", { text: f.scope }), el("td", { text: f.source }), el("td", { text: f.text }), el("td", { class: "n muted", text: (f.createdAt || "").slice(0, 10) })]);
    })) : el("div", { class: "muted", text: "Фактов нет." }));
    if (s.memory.summary) {
      main.appendChild(el("h2", { text: "Сводка разговора (до seq " + s.memory.summary.coversUntil + ", " + fmt(s.memory.summary.tokens) + " ток.)" }));
      main.appendChild(el("pre", { text: s.memory.summary.text }));
    }
    main.appendChild(el("h2", { text: "Авто-recall" + (s.memory.recall ? (s.memory.recall.cached ? " (с первого шага хода)" : "") : "") }));
    if (s.memory.recall) {
      main.appendChild(el("div", { class: "muted", text: "Запросы: " + (s.memory.recall.queries.join(" | ") || "—") + " · " + fmt(s.memory.recall.tokens) + " ток." }));
      main.appendChild(table(["провайдер", "id", "текст"], s.memory.recall.records.map(function (r) {
        return el("tr", {}, [el("td", { text: r.provider + (r.untrusted ? " · untrusted" : "") }), el("td", { class: "muted", text: r.id }), el("td", { text: r.text })]);
      })));
    } else main.appendChild(el("div", { class: "muted", text: "В этом ходе recall не выполнялся (нет плана и memory.recall.auto выключен)." }));

    main.appendChild(el("h2", { text: "Хуки процессоров памяти (" + s.memory.hooks.length + ")" }));
    main.appendChild(s.memory.hooks.length ? table(["плагин/процессор", "хук", "мс", "результат"], s.memory.hooks.map(function (h) {
      var what = !h.ok ? "ошибка, оставлено как было" : h.hook === "onTurnStart" ? (h.queries && h.queries.length ? "запросы: " + h.queries.join(" | ") : "без плана") : h.changed ? "изменил: " + (h.before || []).join(", ") + " → " + (h.after || []).join(", ") : "без изменений";
      return el("tr", {}, [el("td", { text: h.plugin + "/" + h.processor }), el("td", { text: h.hook }), el("td", { class: "n", text: String(h.ms) }), el("td", { class: h.ok ? "" : "warn", text: what })]);
    })) : el("div", { class: "muted", text: "Хуков не было." }));

    main.appendChild(el("h2", { text: "Контекст-плагины (" + s.contexts.length + ")" }));
    if (!s.contexts.length) main.appendChild(el("div", { class: "muted", text: "Нет плагинов с ctx.context()." }));
    s.contexts.forEach(function (c) {
      main.appendChild(el("div", {}, [el("b", { text: c.plugin + "/" + c.name }), el("span", { class: c.ok && !c.reordered ? "muted" : "warn", text: " · " + c.ms + " мс · " + fmt(c.tokensBefore) + " → " + fmt(c.tokensAfter) + " ток." + (c.ok ? "" : " · ошибка: " + (c.error || "")) + (c.reordered ? " · менял сообщения до хвоста: ядро оставило их как были и взяло только то, что плагин дописал в конец" : "") })]));
      c.added.forEach(function (a) { main.appendChild(el("pre", { class: "add", text: "+ [" + a.index + "] " + a.role + ": " + a.content })); });
      c.removed.forEach(function (a) { main.appendChild(el("pre", { class: "rem", text: "- [" + a.index + "] " + a.role + ": " + a.content })); });
      if (c.ok && !c.added.length && !c.removed.length) main.appendChild(el("div", { class: "muted", text: "ничего не изменил" }));
    });

    main.appendChild(el("h2", { text: "Инструменты (" + s.tools.length + ")" }));
    main.appendChild(el("div", { class: "muted", text: s.tools.map(function (t) { return t.name + " " + fmt(t.tokens); }).join(" · ") }));
  }
  function personaText(p) {
    if (p.source === "agent") return "Персона: AGENTS.md агента «" + (p.agentName || "?") + "»";
    if (p.agentName) return "Персона: глобальный ~/.sinty/AGENTS.md (у агента «" + p.agentName + "» поле AGENTS.md пустое)";
    return "Персона: глобальный ~/.sinty/AGENTS.md — у чата и его проекта нет агентов";
  }
  /**
   * The model's context window and how full this step's prompt is: the provider's real prompt size once the step
   * finished, before that the chars/4 estimate × the chat's ratio. The tick marks where the dialogue is folded.
   */
  function windowCard(s) {
    var w = s.window;
    if (!w || !w.tokens) return null;
    var u = s.usage;
    var fact = !!(u && u.inputTokens);
    var used = fact ? u.inputTokens : Math.round(s.tokens.total * (w.ratio || 1));
    var frac = Math.min(1, used / w.tokens), mark = Math.min(1, w.compactAt / w.tokens);
    var NS = "http://www.w3.org/2000/svg", R = 24, C = 2 * Math.PI * R;
    function svg(tag, attrs) { var n = document.createElementNS(NS, tag); for (var k in attrs) n.setAttribute(k, String(attrs[k])); return n; }
    var g = svg("svg", { width: 60, height: 60, viewBox: "0 0 60 60", role: "img" });
    var byCap = w.compactBy === "cap";
    var markLabel = byCap ? "потолок " + fmt(w.compactAt) : "65% окна";
    g.appendChild(svg("title", {})).textContent = "заполнено " + pct(used, w.tokens) + ", сводка с " + pct(w.compactAt, w.tokens) + " (" + markLabel + ")";
    g.appendChild(svg("circle", { cx: 30, cy: 30, r: R, fill: "none", stroke: "var(--line)", "stroke-width": 7 }));
    if (frac > 0) g.appendChild(svg("circle", { cx: 30, cy: 30, r: R, fill: "none", stroke: frac >= mark ? "var(--warn)" : "var(--accent)", "stroke-width": 7, "stroke-dasharray": (Math.max(0.005, frac) * C).toFixed(2) + " " + C.toFixed(2), transform: "rotate(-90 30 30)", "stroke-linecap": frac < 1 ? "round" : "butt" }));
    var a = 2 * Math.PI * mark - Math.PI / 2;
    g.appendChild(svg("line", { x1: (30 + (R - 6) * Math.cos(a)).toFixed(2), y1: (30 + (R - 6) * Math.sin(a)).toFixed(2), x2: (30 + (R + 6) * Math.cos(a)).toFixed(2), y2: (30 + (R + 6) * Math.sin(a)).toFixed(2), stroke: "var(--warn)", "stroke-width": 2, class: "mark" }));
    var t = svg("text", { x: 30, y: 34, "text-anchor": "middle", class: "pct" });
    t.textContent = used / w.tokens < 0.01 && used > 0 ? "<1%" : pct(used, w.tokens);
    g.appendChild(t);
    return el("div", { class: "card win", title: "Окно модели " + w.tokens + " ток. (" + (SOURCES[w.source] || w.source) + "). Сводка диалога — при " + w.compactAt + " ток. диалога (" + (byCap ? "потолок memory.compactCapTokens, он меньше 65% окна" : "65% окна") + ")." }, [
      g,
      el("div", {}, [
        el("b", { text: fmt(w.tokens) }),
        el("span", { text: "окно модели · " + (SOURCES[w.source] || w.source) }),
        el("div", { class: "muted", style: "font-size:11px", text: (fact ? "факт " : "оценка ") + fmt(used) + (!fact && w.ratio ? " (×" + w.ratio + ")" : "") + " · сводка с " + fmt(w.compactAt) + " (" + markLabel + ")" }),
      ]),
    ]);
  }
  function card(v, label, extra) { return el("div", { class: "card" + (extra ? " " + extra : "") }, [el("b", { text: v }), el("span", { text: label })]); }

  setInterval(function () { if (inited && document.getElementById("live").checked && !document.hidden) refresh(); }, 3000);
  parent.postMessage({ sinty: PROTO, op: "ready" }, "*");
})();
</script>
</body>
</html>`;
