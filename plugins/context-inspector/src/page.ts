/**
 * The tab page. The Web UI loads it in `<iframe sandbox="allow-scripts">` (opaque origin): it has no token and, with
 * this CSP, no network at all. Data comes only from the UI's postMessage bridge ({ sinty: "tab/1", op: "get" }),
 * which forwards GETs to this plugin's own routes. All data is rendered with textContent, never as HTML.
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
.wrap { display:grid; grid-template-columns:240px 1fr; min-height:calc(100vh - 46px); }
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
.empty { padding:40px; color:var(--muted); }
.delta { font-size:11px; margin-left:4px; }
.add { color:#1a7f37; } .rem { color:#cf222e; }
</style>
</head>
<body>
<div class="top">
  <h1>Контекст</h1>
  <select id="session" title="Сессия"></select>
  <label class="muted"><input type="checkbox" id="live" checked> обновлять</label>
  <span id="status" class="muted"></span>
</div>
<div class="wrap">
  <div class="steps" id="steps"></div>
  <div class="main" id="main"><div class="empty">Нет снимков. Отправьте сообщение агенту: снимок появляется на каждом шаге модели.</div></div>
</div>
<script>
(function () {
  "use strict";
  var PROTO = "tab/1";
  var COLORS = { system: "#5b6abf", skills: "#7c8b9a", memory: "#2e9d6a", summary: "#c08a1d", recall: "#1f8fb3", processor: "#b04fbf", plugin: "#d0573a", dialogue: "#8a8f98" };
  var NAMES = { system: "системный", skills: "навыки", memory: "память", summary: "сводка", recall: "recall", processor: "процессор", plugin: "плагин", dialogue: "диалог" };
  var seq = 0, pending = {}, state = { session: "", step: "", list: [], snap: null, open: {} };

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
    if (m.op === "init") { document.documentElement.dataset.theme = m.theme === "dark" ? "dark" : "light"; refresh(); return; }
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
  function fmt(n) { return n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(n); }
  function time(iso) { var d = new Date(iso); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  function badge(kind) { return el("span", { class: "kind", style: "background:" + (COLORS[kind] || "#888"), text: NAMES[kind] || kind }); }
  function status(t) { document.getElementById("status").textContent = t; }

  function refresh() {
    return get("/sessions").then(function (r) {
      var sel = document.getElementById("session");
      var sessions = r.sessions || [];
      if (!state.session && sessions.length) state.session = sessions[0].sessionId;
      sel.textContent = "";
      sessions.forEach(function (s) {
        var o = el("option", { value: s.sessionId, text: s.sessionId + " · " + s.steps + " шаг. · " + time(s.lastAt) });
        if (s.sessionId === state.session) o.selected = true;
        sel.appendChild(o);
      });
      if (!state.session) { status("снимков нет"); return; }
      return get("/snapshots?session=" + encodeURIComponent(state.session)).then(function (l) {
        var list = l.snapshots || [];
        var newest = list.length ? list[list.length - 1].id : "";
        var follow = !state.step || (state.list.length && state.step === state.list[state.list.length - 1].id);
        state.list = list;
        if (follow && newest) state.step = newest;
        drawSteps();
        status(list.length + " шаг(ов)");
        if (state.step && (!state.snap || state.snap.id !== state.step)) return open(state.step);
      });
    }).catch(function (e) { status("ошибка: " + e.message); });
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
        el("div", { class: "t", text: time(s.at) + (s.route ? " · " + s.route : "") + (s.redactions ? " · скрыто " + s.redactions : "") }),
      ]);
      b.addEventListener("click", function () { state.step = s.id; drawSteps(); open(s.id); });
      box.appendChild(b);
    });
  }

  function open(id) {
    return get("/snapshots/" + encodeURIComponent(id)).then(function (snap) { state.snap = snap; draw(snap); });
  }

  function table(head, rows) {
    return el("table", {}, [el("tr", {}, head.map(function (h) { return el("th", { text: h }); }))].concat(rows));
  }

  function draw(s) {
    var main = document.getElementById("main");
    main.textContent = "";
    main.appendChild(el("div", { class: "cards" }, [
      card(fmt(s.tokens.total), "токенов всего (оценка)"),
      card(fmt(s.tokens.messages), "сообщения"),
      card(fmt(s.tokens.tools), "схемы " + s.tools.length + " инструм."),
      card(String(s.messages.length), "сообщений"),
      card(String(s.memory.facts.length), "фактов в памяти"),
      card(String(s.memory.recall ? s.memory.recall.records.length : 0), "recall"),
      s.redactions ? card(String(s.redactions), "строк со скрытыми секретами") : null,
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
    main.appendChild(el("div", { class: "muted", text: "Сессия " + s.sessionId + " · ход " + s.turnId + " · шаг " + s.step + " (" + s.stepId + ") · агент " + s.agentId + " · " + new Date(s.at).toLocaleString() }));

    main.appendChild(el("h2", { text: "Что ушло в модель (" + s.parts.length + " сообщений, по порядку)" }));
    var rows = [];
    s.parts.forEach(function (p) {
      var m = s.messages[p.index] || {};
      var preview = (m.content || (m.toolCalls ? "[вызов " + m.toolCalls.map(function (c) { return c.name; }).join(", ") + "]" : "")).replace(/\s+/g, " ").slice(0, 120);
      var tr = el("tr", { class: "part" }, [
        el("td", { class: "n", text: String(p.index) }),
        el("td", {}, [badge(p.kind)]),
        el("td", { text: p.source + (p.id ? " · " + p.id : "") + (p.untrusted ? " · untrusted" : "") }),
        el("td", { text: m.role || "" }),
        el("td", { class: "muted", text: preview }),
        el("td", { class: "n", text: fmt(p.tokens) }),
      ]);
      var key = s.id + ":" + p.index;
      var detail = el("tr", { style: state.open[key] ? "" : "display:none" }, [el("td", { colspan: "6" }, [el("pre", { text: (m.content || "") + (m.toolCalls ? "\n\n" + JSON.stringify(m.toolCalls, null, 2) : "") + (m.toolCallId ? "\n\n[toolCallId " + m.toolCallId + "]" : "") })])]);
      tr.addEventListener("click", function () { state.open[key] = !state.open[key]; detail.style.display = state.open[key] ? "" : "none"; });
      rows.push(tr, detail);
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
      main.appendChild(el("div", {}, [el("b", { text: c.plugin + "/" + c.name }), el("span", { class: c.ok ? "muted" : "warn", text: " · " + c.ms + " мс · " + fmt(c.tokensBefore) + " → " + fmt(c.tokensAfter) + " ток." + (c.ok ? "" : " · ошибка: " + (c.error || "")) })]));
      c.added.forEach(function (a) { main.appendChild(el("pre", { class: "add", text: "+ [" + a.index + "] " + a.role + ": " + a.content })); });
      c.removed.forEach(function (a) { main.appendChild(el("pre", { class: "rem", text: "- [" + a.index + "] " + a.role + ": " + a.content })); });
      if (c.ok && !c.added.length && !c.removed.length) main.appendChild(el("div", { class: "muted", text: "ничего не изменил" }));
    });

    main.appendChild(el("h2", { text: "Инструменты (" + s.tools.length + ")" }));
    main.appendChild(el("div", { class: "muted", text: s.tools.map(function (t) { return t.name + " " + fmt(t.tokens); }).join(" · ") }));
  }
  function card(v, label) { return el("div", { class: "card" }, [el("b", { text: v }), el("span", { text: label })]); }

  document.getElementById("session").addEventListener("change", function (e) { state.session = e.target.value; state.step = ""; state.list = []; state.snap = null; refresh(); });
  setInterval(function () { if (document.getElementById("live").checked && !document.hidden) refresh(); }, 3000);
  parent.postMessage({ sinty: PROTO, op: "ready" }, "*");
})();
</script>
</body>
</html>`;
