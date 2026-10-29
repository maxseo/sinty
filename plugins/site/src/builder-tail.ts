/** Visual constructor: dark canvas, nested block frames, properties on the right. */
export function builderHtml(): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Конструктор</title>
<style>
html,body{margin:0;height:100%;background:#1e1e1e;color:#f5f5f5;font:12px/1.4 system-ui,sans-serif}
button,select,input{font:inherit;color:inherit}
button{cursor:pointer}
.top{position:fixed;top:0;left:0;right:0;height:44px;background:#2b2b2b;border-bottom:1px solid #1a1a1a;display:flex;align-items:center;gap:8px;padding:0 8px;z-index:3}
.top button{border:0;border-radius:4px;padding:6px 10px}
.pub{background:#0d7ed9;color:#fff}
.danger{background:#f44336;color:#fff}
.top select{background:#383838;border:1px solid #404040;border-radius:4px;padding:4px 6px}
.stage{position:fixed;top:44px;right:280px;bottom:42px;left:0;overflow:auto;background:#1e1e1e}
.sheet{width:var(--w,1024px);margin:24px auto;background:#111;min-height:400px;box-shadow:0 8px 16px rgba(0,0,0,.5)}
.block{margin:12px;border:2px solid #c6a15b;padding:8px;position:relative}
.line{margin:8px;border:2px solid #7dce7a;padding:8px}
.col{border:2px solid #7aa2ff;padding:8px;min-height:48px}
.tag{position:absolute;top:-9px;left:8px;font-size:10px;background:#1e1e1e;padding:0 4px;color:#b8b8b8}
.widget{border:1px solid #c06ad6;margin:6px 0;padding:8px;background:#161616;cursor:pointer}
.widget.on{outline:2px solid #0d7ed9}
.side{position:fixed;top:44px;right:0;bottom:42px;width:280px;background:#2b2b2b;border-left:1px solid #1a1a1a;padding:12px;box-sizing:border-box;overflow:auto}
.side h2{margin:0 0 8px;font-size:14px}
.side label{display:block;margin:8px 0;color:#b8b8b8}
.side input,.side select,.side textarea{width:100%;box-sizing:border-box;background:#383838;border:1px solid #404040;color:#f5f5f5;padding:6px}
.bottom{position:fixed;left:0;right:0;bottom:0;height:42px;background:#2b2b2b;border-top:1px solid #1a1a1a;display:flex;align-items:center;gap:6px;padding:0 8px}
.bottom button{background:#383838;border:1px solid #404040;border-radius:4px;padding:4px 8px}
.empty{color:#808080;padding:24px;text-align:center}
</style></head><body>
<div class="top">
  <button type="button" class="pub" id="publish">Опубликовать</button>
  <span>Тип страницы</span>
  <select id="ptype"><option value="0">Главная</option><option value="1">Страница</option><option value="3">Категория</option></select>
  <select id="pick"></select>
  <button type="button" class="danger" id="reset">Сбросить шаблон</button>
  <span id="widthLabel" style="margin-left:auto">1024 px</span>
  <select id="device"><option value="1024">1024</option><option value="390">390</option><option value="768">768</option><option value="1280">1280</option></select>
</div>
<div class="stage"><div class="sheet" id="sheet"></div></div>
<aside class="side"><h2>Свойства</h2><div id="props">Выберите элемент</div></aside>
<div class="bottom">
  <button type="button" id="addBlock">Блок</button>
  <button type="button" id="addRow">Строка</button>
  <button type="button" id="addCol">Колонка</button>
  <select id="wtype"><option value="title">Заголовок</option><option value="text">Текст</option><option value="image">Картинка</option><option value="button">Кнопка</option><option value="menu">Меню</option><option value="form">Форма</option></select>
  <button type="button" id="addWidget">Виджет</button>
  <button type="button" id="save">Сохранить</button>
</div>
<script>
const send = (op, extra) => parent.postMessage(Object.assign({ sinty: "tab/1", op }, extra || {}), "*");
let n = 0; const wait = new Map();
addEventListener("message", (e) => { const m = e.data || {}; if (m.sinty !== "tab/1") return; if (typeof m.id === "number" && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
function ask(op, path, body) { const id = ++n; return new Promise((ok) => { wait.set(id, ok); send(op, { id, path, body }); }); }
const names = { title: "Заголовок", text: "Текст", image: "Картинка", button: "Кнопка", menu: "Меню", form: "Форма" };
let records = [];
let current = null;
let tree = [];
let sel = null;
function blankWidget(type) { return { type: type, props: type === "image" ? { src: "" } : type === "form" ? { fields: "name,email,message" } : { text: "" } }; }
function ensure() {
  if (!tree.length) tree.push({ rows: [{ cols: [{ widgets: [] }] }] });
  return tree[tree.length - 1];
}
function draw() {
  const sheet = document.getElementById("sheet");
  sheet.textContent = "";
  if (!current) { const p = document.createElement("p"); p.className = "empty"; p.textContent = "Нет страницы"; sheet.append(p); return; }
  if (!tree.length) { const p = document.createElement("p"); p.className = "empty"; p.textContent = "Пустой шаблон. Добавьте блок."; sheet.append(p); }
  tree.forEach((block, bi) => {
    const b = document.createElement("div"); b.className = "block";
    const t = document.createElement("span"); t.className = "tag"; t.textContent = "БЛОК"; b.append(t);
    (block.rows || []).forEach((row, ri) => {
      const r = document.createElement("div"); r.className = "line";
      const rt = document.createElement("span"); rt.className = "tag"; rt.textContent = "СТРОКА"; r.append(rt);
      const grid = document.createElement("div"); grid.style.display = "grid"; grid.style.gridTemplateColumns = "repeat(" + Math.max(1, (row.cols || []).length) + ", 1fr)"; grid.style.gap = "8px";
      (row.cols || []).forEach((col, ci) => {
        const c = document.createElement("div"); c.className = "col";
        const ct = document.createElement("span"); ct.className = "tag"; ct.textContent = "КОЛОНКА"; c.append(ct);
        (col.widgets || []).forEach((w, wi) => {
          const el = document.createElement("div");
          el.className = "widget" + (sel && sel.bi === bi && sel.ri === ri && sel.ci === ci && sel.wi === wi ? " on" : "");
          const cap = document.createElement("div"); cap.style.color = "#b8b8b8"; cap.textContent = names[w.type] || w.type;
          const body = document.createElement("div");
          const p = w.props || {};
          body.textContent = w.type === "image" ? (p.src || "картинка") : (p.text || p.fields || "");
          el.append(cap, body);
          el.onclick = () => { sel = { bi: bi, ri: ri, ci: ci, wi: wi }; draw(); showProps(); };
          c.append(el);
        });
        grid.append(c);
      });
      r.append(grid); b.append(r);
    });
    sheet.append(b);
  });
}
function showProps() {
  const box = document.getElementById("props");
  box.textContent = "";
  if (!sel) { box.textContent = "Выберите элемент"; return; }
  const w = tree[sel.bi].rows[sel.ri].cols[sel.ci].widgets[sel.wi];
  const label = document.createElement("label");
  label.textContent = names[w.type] || w.type;
  const field = document.createElement("textarea");
  field.rows = 4;
  const key = w.type === "image" ? "src" : w.type === "form" ? "fields" : "text";
  field.value = (w.props && w.props[key]) || "";
  field.oninput = () => { w.props = w.props || {}; w.props[key] = field.value; draw(); };
  const del = document.createElement("button");
  del.type = "button"; del.textContent = "Удалить виджет"; del.style.marginTop = "8px";
  del.onclick = () => { tree[sel.bi].rows[sel.ri].cols[sel.ci].widgets.splice(sel.wi, 1); sel = null; draw(); showProps(); };
  box.append(label, field, del);
}
function fillPick() {
  const type = document.getElementById("ptype").value;
  const selEl = document.getElementById("pick");
  selEl.hidden = type === "0";
  selEl.textContent = "";
  const rows = type === "1" ? records.filter((r) => r.kind === "page" && !r.home) : type === "3" ? records.filter((r) => r.kind === "category") : [];
  for (const r of rows) { const o = document.createElement("option"); o.value = r.id; o.textContent = r.title; selEl.append(o); }
}
function open(r) {
  current = r;
  tree = JSON.parse(JSON.stringify(r.layout || []));
  sel = null;
  draw();
  showProps();
}
async function loadRecords() {
  const m = await ask("get", "/builder-docs");
  records = (m.data && m.data.records) || [];
  fillPick();
}
async function openCurrent() {
  const type = document.getElementById("ptype").value;
  if (type === "0") {
    let home = records.find((r) => r.home);
    if (!home) {
      const m = await ask("post", "/edit", { action: "create", kind: "page", home: true, title: "Главная" });
      if (!m.ok) return;
      home = m.data; records.push(home);
    }
    open(home); return;
  }
  const id = document.getElementById("pick").value;
  const row = records.find((r) => r.id === id);
  if (row) open(row);
}
document.getElementById("ptype").onchange = () => { fillPick(); openCurrent(); };
document.getElementById("pick").onchange = openCurrent;
document.getElementById("device").onchange = () => {
  const w = document.getElementById("device").value;
  document.getElementById("sheet").style.setProperty("--w", w + "px");
  document.getElementById("widthLabel").textContent = w + " px";
};
document.getElementById("addBlock").onclick = () => { tree.push({ rows: [{ cols: [{ widgets: [] }] }] }); draw(); };
document.getElementById("addRow").onclick = () => { ensure().rows.push({ cols: [{ widgets: [] }] }); draw(); };
document.getElementById("addCol").onclick = () => { const b = ensure(); const row = b.rows[b.rows.length - 1]; row.cols.push({ widgets: [] }); draw(); };
document.getElementById("addWidget").onclick = () => {
  const b = ensure(); const row = b.rows[b.rows.length - 1]; const col = row.cols[row.cols.length - 1];
  col.widgets.push(blankWidget(document.getElementById("wtype").value));
  sel = { bi: tree.length - 1, ri: b.rows.length - 1, ci: row.cols.length - 1, wi: col.widgets.length - 1 };
  draw(); showProps();
};
document.getElementById("reset").onclick = () => { if (!confirm("Сбросить шаблон?")) return; tree = []; sel = null; draw(); showProps(); };
document.getElementById("save").onclick = async () => {
  if (!current) return;
  const m = await ask("post", "/edit", { action: "layout", id: current.id, layout: tree });
  if (!m.ok) { alert((m.error && m.error.message) || "не сохранилось"); return; }
  current = m.data;
};
document.getElementById("publish").onclick = async () => {
  if (!current) return;
  const saved = await ask("post", "/edit", { action: "layout", id: current.id, layout: tree });
  if (!saved.ok) { alert("не сохранилось"); return; }
  const m = await ask("post", "/edit", { action: "status", id: current.id, status: "published" });
  if (!m.ok) { alert((m.error && m.error.message) || "не опубликовано"); return; }
  current = m.data;
};
loadRecords().then(openCurrent);
send("ready");
</script></body></html>`;
}
