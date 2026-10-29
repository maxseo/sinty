/** Admin lists. The iframe has no token; the harness bridge adds it to GET /docs. Text only, no HTML from records. */
export const TAB_CSP = ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"].join("; ");

export function tabHtml(which: "pages" | "blog" | "builder"): string {
  const title = which === "pages" ? "Страницы" : which === "blog" ? "Блог" : "Конструктор";
  const kinds = which === "pages" ? "page,template" : which === "blog" ? "post,category" : "page,post,template";
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title>
<style>
body{margin:0;font:14px/1.45 system-ui,sans-serif;color:#1d1d1f;background:#fff}
h1{font-size:16px;margin:0;padding:12px 16px;border-bottom:1px solid #e5e5ea}
ul{list-style:none;margin:0;padding:0}
li{padding:8px 16px;border-bottom:1px solid #f0f0f2}
.muted{color:#6e6e73;font-size:12px}
#body{padding:16px;white-space:pre-wrap}
button{font:inherit;background:none;border:0;padding:0;cursor:pointer;text-align:left}
</style></head><body>
<h1>${title}</h1>
<ul id="list"></ul>
<div id="body"></div>
<script>
const kinds = ${JSON.stringify(kinds.split(","))};
const send = (op, extra) => parent.postMessage(Object.assign({ sinty: "tab/1", op }, extra || {}), "*");
let n = 0;
const wait = new Map();
addEventListener("message", (e) => {
  const m = e.data || {};
  if (m.sinty !== "tab/1") return;
  if (m.op === "init") send("get", { id: ++n, path: "/docs" });
  if (typeof m.id === "number" && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
});
function ask(path) {
  const id = ++n;
  return new Promise((ok) => { wait.set(id, ok); send("get", { id, path }); });
}
ask("/docs").then((m) => {
  const rows = ((m.data && m.data.records) || []).filter((r) => kinds.includes(r.kind));
  const ul = document.getElementById("list");
    if (!rows.length) ul.innerHTML = '<li class="muted">Пока пусто. Страницу можно собрать на вкладке Конструктор или попросить агента.</li>';
  const builder = ${JSON.stringify(which === "builder")};
  for (const r of rows) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = r.title;
    const s = document.createElement("span");
    s.className = "muted";
    s.textContent = " · " + r.kind + " · " + r.status + " · /" + r.slug;
    b.onclick = () => {
      const box = document.getElementById("body");
      if (!builder) { box.textContent = r.body || "(пусто)"; return; }
      const types = [];
      for (const block of r.layout || []) for (const row of block.rows || []) for (const col of row.cols || []) for (const w of col.widgets || []) types.push(w.type);
      box.textContent = types.length ? types.join(", ") : "(конструктор пуст)";
    };
    li.append(b, s);
    ul.append(li);
  }
});
send("ready");
</script></body></html>`;
}

const WIDGETS = ["title", "text", "image", "button", "menu", "form"];

/** Human constructor. One column of widgets. Saves through the tab bridge (POST /edit). */
export function builderHtml(): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Конструктор</title>
<style>
body{margin:0;font:14px/1.45 system-ui,sans-serif;color:#1d1d1f}
h1{font-size:16px;margin:0;padding:12px 16px;border-bottom:1px solid #e5e5ea}
form,section{padding:12px 16px}
label{display:block;margin:8px 0}
input,select,button,textarea{font:inherit}
.row{display:flex;gap:8px;align-items:center;margin:6px 0}
.muted{color:#6e6e73}
button{cursor:pointer}
</style></head><body>
<h1>Конструктор</h1>
<form id="create">
  <div class="row">
    <select name="kind"><option value="page">Страница</option><option value="post">Пост</option><option value="category">Категория</option><option value="template">Шаблон</option></select>
    <input name="title" required placeholder="Название">
    <input name="slug" required placeholder="адрес-латиницей" pattern="[a-z0-9]+(-[a-z0-9]+)*">
    <button>Создать</button>
  </div>
  <p class="muted">Новая запись — черновик. Адрес главной: home.</p>
</form>
<ul id="list"></ul>
<section id="edit" hidden>
  <p id="meta"></p>
  <div id="widgets"></div>
  <div class="row">
    <select id="wtype">${WIDGETS.map((w) => `<option value="${w}">${w}</option>`).join("")}</select>
    <input id="wtext" placeholder="текст, адрес картинки или подпись кнопки">
    <button type="button" id="add">Добавить виджет</button>
  </div>
  <div class="row">
    <button type="button" id="save">Сохранить конструктор</button>
    <button type="button" id="publish">Опубликовать</button>
    <button type="button" id="draft">В черновик</button>
  </div>
  <p class="muted">Одна колонка. Агент по-прежнему может записать более сложное дерево инструментом site.layout; следующее сохранение здесь соберёт виджеты в одну колонку.</p>
</section>
<script>
const send = (op, extra) => parent.postMessage(Object.assign({ sinty: "tab/1", op }, extra || {}), "*");
let n = 0; const wait = new Map();
addEventListener("message", (e) => {
  const m = e.data || {};
  if (m.sinty !== "tab/1") return;
  if (typeof m.id === "number" && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
});
function ask(op, path, body) {
  const id = ++n;
  return new Promise((ok) => { wait.set(id, ok); send(op, { id, path, body }); });
}
let current = null;
let widgets = [];
function widgetLabel(w) {
  const p = w.props || {};
  return w.type + ": " + (p.text || p.src || p.items || p.fields || "");
}
function drawWidgets() {
  const box = document.getElementById("widgets");
  box.textContent = "";
  widgets.forEach((w, i) => {
    const row = document.createElement("div");
    row.className = "row";
    const span = document.createElement("span");
    span.textContent = widgetLabel(w);
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Убрать";
    del.onclick = () => { widgets.splice(i, 1); drawWidgets(); };
    row.append(span, del);
    box.append(row);
  });
}
function flatten(layout) {
  const out = [];
  for (const b of layout || []) for (const r of b.rows || []) for (const c of r.cols || []) for (const w of c.widgets || []) out.push({ type: w.type, props: w.props || {} });
  return out;
}
async function reload() {
  const m = await ask("get", "/builder-docs");
  const rows = (m.data && m.data.records) || [];
  const ul = document.getElementById("list");
  ul.textContent = "";
  for (const r of rows) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = r.title + " · " + r.kind + " · " + r.status + " · /" + r.slug;
    b.onclick = () => open(r);
    li.append(b);
    ul.append(li);
  }
}
function open(r) {
  current = r;
  widgets = flatten(r.layout);
  document.getElementById("edit").hidden = false;
  document.getElementById("meta").textContent = r.title + " /" + r.slug;
  drawWidgets();
}
document.getElementById("create").onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const m = await ask("post", "/edit", { action: "create", kind: fd.get("kind"), title: fd.get("title"), slug: fd.get("slug") });
  if (!m.ok) { alert((m.error && m.error.message) || "не сохранилось"); return; }
  e.target.reset();
  await reload();
};
document.getElementById("add").onclick = () => {
  const type = document.getElementById("wtype").value;
  const text = document.getElementById("wtext").value.trim();
  const props = {};
  if (type === "image") props.src = text;
  else if (type === "menu") props.items = text;
  else if (type === "form") props.fields = text || "name,email,phone,telegram,message";
  else props.text = text;
  widgets.push({ type, props });
  document.getElementById("wtext").value = "";
  drawWidgets();
};
document.getElementById("save").onclick = async () => {
  if (!current) return;
  const m = await ask("post", "/edit", { action: "layout", id: current.id, widgets });
  if (!m.ok) { alert((m.error && m.error.message) || "не сохранилось"); return; }
  current = m.data;
  await reload();
};
async function setStatus(status) {
  if (!current) return;
  const m = await ask("post", "/edit", { action: "status", id: current.id, status });
  if (!m.ok) { alert((m.error && m.error.message) || "не сохранилось"); return; }
  current = m.data;
  document.getElementById("meta").textContent = current.title + " /" + current.slug + " · " + current.status;
  await reload();
}
document.getElementById("publish").onclick = () => setStatus("published");
document.getElementById("draft").onclick = () => setStatus("draft");
reload();
send("ready");
</script></body></html>`;
}
