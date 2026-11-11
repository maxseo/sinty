/** Settings page for the RunningHub standard-model catalog. It talks to the harness only through postMessage. */
export function tabHtml() {
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>RunningHub</title>
<style>
:root{color-scheme:light;--bg:#f4f4f5;--panel:#fff;--text:#050505;--muted:#71717a;--line:rgba(0,0,0,.1);--accent:#74ff2a}
[data-theme="dark"]{color-scheme:dark;--bg:#050505;--panel:#141414;--text:#fff;--muted:#a1a1aa;--line:rgba(255,255,255,.12)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif}
header{padding:16px 16px 8px}
h1{font-size:16px;margin:0 0 4px}
p{margin:0;color:var(--muted)}
.bar{display:flex;gap:8px;flex-wrap:wrap;padding:8px 16px}
input,select,button,textarea{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 10px}
button.primary{background:var(--accent);color:#111;border-color:transparent;cursor:pointer}
button:disabled{opacity:.6}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;padding:8px 16px 24px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;cursor:pointer}
.card b{display:block}
.card span{color:var(--muted);font-size:12px}
.err{color:#b91c1c;padding:0 16px 8px}
form{padding:0 16px 24px;display:grid;gap:8px;max-width:640px}form[hidden]{display:none}
label{display:grid;gap:4px}
pre{white-space:pre-wrap;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px}
table{width:calc(100% - 32px);margin:8px 16px 16px;border-collapse:collapse;background:var(--panel)}
th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
tr{cursor:pointer}
#history[hidden],#catalog[hidden]{display:none}
</style></head><body>
<header>
  <h1>RunningHub</h1>
  <p id="status">Каталог стандартных моделей. Текстовые модели и ключ — в разделе «Модели», плашка runninghub.</p>
</header>
<div class="bar">
  <button type="button" id="show-catalog" class="primary">Каталог</button>
  <button type="button" id="show-history">История</button>
</div>
<div id="catalog">
<div class="bar">
  <input id="q" placeholder="поиск: nano, video, suno">
  <select id="kind"><option value="">все</option><option value="image">картинка</option><option value="video">видео</option><option value="audio">звук</option><option value="3d">3D</option></select>
  <button type="button" id="find" class="primary">Найти</button>
  <button type="button" id="refresh">Обновить реестр</button>
</div>
<p id="err" class="err"></p>
<div id="grid" class="grid"></div>
<form id="form" hidden>
  <b id="form-title"></b>
  <div id="fields"></div>
  <button type="submit" class="primary">Запустить</button>
  <pre id="out" hidden></pre>
</form>
</div>
<div id="history" hidden>
  <table>
    <thead><tr><th>Время</th><th>Модель</th><th>Статус</th><th>Длительность</th><th>Задача</th><th>Монеты</th><th>Сумма</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <pre id="detail" hidden></pre>
</div>
<script>
const send = (op, extra) => parent.postMessage(Object.assign({ sinty: "tab/1", op }, extra || {}), "*");
let n = 0; const wait = new Map();
addEventListener("message", (e) => {
  const m = e.data || {};
  if (m.sinty !== "tab/1") return;
  if (m.op === "init" && m.theme) document.documentElement.dataset.theme = m.theme;
  if (typeof m.id === "number" && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
});
function ask(op, path, body) {
  const id = ++n;
  return new Promise((ok) => { wait.set(id, ok); send(op, { id, path, body }); });
}
const errEl = document.getElementById("err");
const grid = document.getElementById("grid");
const form = document.getElementById("form");
let current = null;
function setErr(text) { errEl.textContent = text || ""; }
async function loadStatus() {
  const m = await ask("get", "/status");
  const d = m.data || {};
  document.getElementById("status").textContent = "Моделей в реестре: " + (d.count || 0) + (d.version ? " (" + d.version + ")" : "") + ". Ключ " + (d.hasKey ? "задан на плашке runninghub." : "не задан: введите его в Настройки → Модели, плашка runninghub, и сохраните.") + " Адрес моделей: " + (d.baseUrl || "");
  if (d.registryError) setErr(d.registryError);
}
async function search() {
  setErr("");
  const q = document.getElementById("q").value;
  const kind = document.getElementById("kind").value;
  const m = await ask("get", "/search?limit=1000&q=" + encodeURIComponent(q) + "&type=" + encodeURIComponent(kind));
  if (!m.ok) { setErr((m.error && m.error.message) || "Поиск не выполнился."); return; }
  grid.replaceChildren();
  const items = (m.data && m.data.items) || [];
  const total = m.data && m.data.total;
  if (!items.length) { setErr("Ничего не найдено."); return; }
  if (total > items.length) setErr("Показано " + items.length + " из " + total + ". Уточните поиск.");
  for (const item of items) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "card";
    const name = document.createElement("b");
    name.textContent = item.name || item.endpoint;
    const meta = document.createElement("span");
    meta.textContent = (item.outputType || item.category || "") + " · " + item.endpoint;
    card.append(name, meta);
    card.onclick = () => openItem(item.endpoint);
    grid.append(card);
  }
}
async function openItem(endpoint) {
  setErr("");
  const m = await ask("get", "/schema?endpoint=" + encodeURIComponent(endpoint));
  if (!m.ok || !m.data || !m.data.model) { setErr((m.error && m.error.message) || "Схема не открылась."); return; }
  current = m.data.model;
  form.hidden = false;
  document.getElementById("form-title").textContent = (current.name_en || current.endpoint);
  const fields = document.getElementById("fields");
  fields.replaceChildren();
  for (const p of current.params || []) {
    const label = document.createElement("label");
    label.textContent = p.fieldKey + (p.required ? " *" : "") + " · " + p.type + (p.type === "IMAGE" || p.type === "VIDEO" || p.type === "AUDIO" ? " — локальный файл передаёт агент, сюда можно вставить уже загруженный https-адрес" : "");
    let input;
    if (p.type === "LIST" && p.options) {
      input = document.createElement("select");
      for (const opt of p.options) {
        const o = document.createElement("option");
        o.value = opt; o.textContent = opt;
        if (opt === p.defaultValue) o.selected = true;
        input.append(o);
      }
    } else if (p.type === "BOOLEAN") {
      input = document.createElement("input");
      input.type = "checkbox";
    } else {
      input = document.createElement("input");
      input.value = p.defaultValue || "";
    }
    input.dataset.field = p.fieldKey;
    input.dataset.type = p.type;
    label.append(input);
    fields.append(label);
  }
  document.getElementById("out").hidden = true;
}
form.onsubmit = async (e) => {
  e.preventDefault();
  if (!current) return;
  setErr("");
  const payload = {};
  for (const input of document.querySelectorAll("[data-field]")) {
    const type = input.dataset.type;
    if (type === "BOOLEAN") payload[input.dataset.field] = input.checked;
    else if (input.value !== "") payload[input.dataset.field] = type === "INT" || type === "FLOAT" ? Number(input.value) : input.value;
  }
  const btn = form.querySelector("button");
  btn.disabled = true;
  const m = await ask("post", "/run", { endpoint: current.endpoint, payload });
  btn.disabled = false;
  const out = document.getElementById("out");
  out.hidden = false;
  if (!m.ok) { out.textContent = (m.error && m.error.message) || "Запуск не прошёл."; return; }
  out.textContent = JSON.stringify(m.data, null, 2);
};
document.getElementById("find").onclick = () => search();
document.getElementById("q").addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
document.getElementById("refresh").onclick = async () => {
  setErr("");
  const m = await ask("post", "/registry", {});
  if (!m.ok) { setErr((m.error && m.error.message) || "Реестр не обновился."); return; }
  await loadStatus();
  await search();
};
function clock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
function showCatalog() {
  document.getElementById("catalog").hidden = false;
  document.getElementById("history").hidden = true;
}
async function showHistory() {
  document.getElementById("catalog").hidden = true;
  document.getElementById("history").hidden = false;
  setErr("");
  const m = await ask("get", "/history");
  const rows = document.getElementById("rows");
  rows.replaceChildren();
  if (!m.ok) { setErr((m.error && m.error.message) || "История не открылась."); return; }
  const items = (m.data && m.data.items) || [];
  if (!items.length) { setErr("Генераций пока нет."); return; }
  for (const item of items) {
    const tr = document.createElement("tr");
    const cells = [
      item.startedAt ? new Date(item.startedAt).toLocaleString("ru") : "",
      item.name || item.endpoint,
      item.status === "success" ? "успех" : item.status === "failed" ? "ошибка" : item.status,
      clock(item.durationMs || 0),
      item.taskId || "—",
      item.coins || "—",
      item.amount || "—",
    ];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    tr.onclick = () => {
      const detail = document.getElementById("detail");
      let outputs = item.outputs || "";
      try { outputs = JSON.stringify(JSON.parse(item.outputs || "[]"), null, 2); } catch (e) {}
      detail.hidden = false;
      detail.textContent = (item.error ? item.error + "\\n\\n" : "") + (item.payload || "") + "\\n\\n" + outputs;
    };
    rows.append(tr);
  }
}
document.getElementById("show-catalog").onclick = () => { setErr(""); showCatalog(); };
document.getElementById("show-history").onclick = () => showHistory();
loadStatus();
search();
send("ready");
</script></body></html>`;
}
//# sourceMappingURL=tab-page.js.map