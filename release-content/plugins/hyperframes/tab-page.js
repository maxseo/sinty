/** The Hyperframes sidebar page. It only talks to the harness through postMessage. */
export function tabHtml() {
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Hyperframes</title>
<style>
:root{color-scheme:light;--bg:#f4f4f5;--panel:#fff;--text:#050505;--muted:#71717a;--line:rgba(0,0,0,.1);--accent:#74ff2a;--danger:#b91c1c}
[data-theme="dark"]{color-scheme:dark;--bg:#050505;--panel:#141414;--text:#fff;--muted:#a1a1aa;--line:rgba(255,255,255,.12);--danger:#fca5a5}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif}
h1{font-size:16px;margin:0;padding:16px 16px 12px}
.bar{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:0 16px 12px}
.bar p{margin:0}
.row{display:flex;flex-wrap:wrap;gap:8px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#d1242f;margin-right:6px}
.ok{color:var(--muted)}
.err{color:var(--danger);padding:0 16px 8px}
button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:8px;padding:6px 10px}
button.primary{background:var(--accent);color:#111;border-color:transparent}
button:disabled{opacity:.6;cursor:default}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;padding:4px 16px 28px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.thumb{aspect-ratio:16/9;background:#e8e8e8;width:100%;object-fit:cover;display:block}
.ph{aspect-ratio:16/9;display:grid;place-items:center;color:var(--muted);background:#e8e8e8}
[data-theme="dark"] .thumb,[data-theme="dark"] .ph{background:#222}
.card h2{font-size:14px;margin:10px 12px 0;word-break:break-word}
.meta{color:var(--muted);font-size:12px;margin:2px 12px 0}
.actions{display:flex;gap:8px;padding:10px 12px 12px}
.empty{color:var(--muted);padding:8px 16px 24px}
.full{display:none}
.full.open{position:fixed;inset:0;background:rgba(0,0,0,.78);display:flex;flex-direction:column;z-index:2}
.full header{display:flex;gap:8px;align-items:center;padding:10px 12px;color:#fff}
.full header strong{flex:1}
.full video,.full iframe{flex:1;width:100%;min-height:0;border:0;background:#000}
.full button{background:#111;color:#fff}
</style></head><body>
<h1>Hyperframes</h1>
<div class="bar">
  <p id="state" class="ok">Проверяю обновления…</p>
  <div class="row" id="row">
    <button type="button" id="update" class="primary" style="background:#74ff2a;color:#111">Установить</button>
    <button type="button" id="seen">Отметить просмотренным</button>
  </div>
</div>
<p id="err" class="err" hidden></p>
<div id="grid" class="grid"></div>
<p id="empty" class="empty" hidden>Пока нет сохранённых гиперфреймов.</p>
<div id="full" class="full">
  <header>
    <strong id="full-title"></strong>
    <button type="button" id="full-html" hidden>Композиция</button>
    <button type="button" id="full-video" hidden>Ролик</button>
    <button type="button" id="full-close">Закрыть</button>
  </header>
  <div id="full-body"></div>
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
const stateEl = document.getElementById("state");
const errEl = document.getElementById("err");
const row = document.getElementById("row");
const updateBtn = document.getElementById("update");
const seenBtn = document.getElementById("seen");
let remoteVersion = "";
function setErr(text) { errEl.hidden = !text; errEl.textContent = text || ""; }
function show(data) {
  stateEl.replaceChildren();
  if (!data || data.error || !data.remote) { stateEl.textContent = "Не удалось спросить GitHub или npm."; row.style.display = "none"; return; }
  remoteVersion = data.remote && data.remote.version || "";
  const behind = !data.installed || data.installed !== remoteVersion;
  const showUpdate = data.update || behind;
  updateBtn.textContent = data.installed ? "Обновить" : "Установить";
  updateBtn.style.display = showUpdate ? "inline-block" : "none";
  seenBtn.style.display = data.update ? "inline-block" : "none";
  if (data.update) {
    const dot = document.createElement("span");
    dot.className = "dot";
    stateEl.className = "";
    stateEl.append(dot, document.createTextNode("Есть обновление: npm " + remoteVersion + (data.remote.title ? ". " + data.remote.title : "")), document.createElement("br"), updateBtn, document.createTextNode(" "), seenBtn);
  } else {
    stateEl.className = "ok";
    stateEl.append(document.createTextNode(data.installed ? "Установлено " + data.installed + ". Обновлений нет." : "Обновлений нет. Сейчас npm " + remoteVersion + ". "));
    if (showUpdate) stateEl.append(updateBtn);
  }
  row.style.display = "none";
}
function card(item) {
  const el = document.createElement("article");
  el.className = "card";
  if (item.thumb) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.alt = "";
    img.src = item.thumb;
    el.append(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "ph";
    ph.textContent = "нет кадра";
    el.append(ph);
  }
  const h = document.createElement("h2");
  h.textContent = item.name || item.slug;
  const meta = document.createElement("div");
  meta.className = "meta";
  const bits = [];
  if (item.width && item.height) bits.push(item.width + "×" + item.height);
  bits.push(item.hasVideo ? "есть ролик" : "только композиция");
  meta.textContent = bits.join(" · ");
  const actions = document.createElement("div");
  actions.className = "actions";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "primary";
  open.textContent = "Открыть";
  open.onclick = () => openItem(item, item.hasVideo ? "video" : "html");
  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "Удалить";
  del.onclick = () => removeItem(item);
  actions.append(open, del);
  el.append(h, meta, actions);
  return el;
}
async function loadItems() {
  const m = await ask("get", "/items");
  const grid = document.getElementById("grid");
  const empty = document.getElementById("empty");
  grid.replaceChildren();
  const items = m && m.ok && m.data && m.data.items ? m.data.items : [];
  if (!m.ok) setErr((m.error && m.error.message) || "Список не открылся.");
  empty.hidden = items.length > 0;
  items.forEach((item) => grid.append(card(item)));
}
async function load() { const m = await ask("get", "/status"); show(m.ok ? m.data : m.error); await loadItems(); }
let opened = null;
function showPiece(kind, data) {
  const body = document.getElementById("full-body");
  body.replaceChildren();
  if (kind === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.autoplay = true;
    video.src = "data:video/mp4;base64," + data.video;
    body.append(video);
  } else {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.srcdoc = data.html || "";
    body.append(frame);
  }
}
async function openItem(item, view) {
  setErr("");
  const m = await ask("get", "/open?slug=" + encodeURIComponent(item.slug) + "&view=" + view);
  if (!m.ok || !m.data) { setErr((m.error && m.error.message) || "Не открылось."); return; }
  opened = item;
  document.getElementById("full-title").textContent = item.name || item.slug;
  document.getElementById("full-html").style.display = item.hasVideo ? "inline-block" : "none";
  document.getElementById("full-video").style.display = item.hasVideo ? "inline-block" : "none";
  document.getElementById("full").classList.add("open");
  showPiece(view, m.data);
}
async function removeItem(item) {
  if (!confirm("Удалить «" + (item.name || item.slug) + "»? Папка гиперфрейма исчезнет.")) return;
  setErr("");
  const m = await ask("post", "/delete", { slug: item.slug });
  if (!m.ok) { setErr((m.error && m.error.message) || "Не удалилось."); return; }
  await loadItems();
}
updateBtn.onclick = async () => {
  updateBtn.disabled = true;
  const prev = updateBtn.textContent;
  updateBtn.textContent = "Обновляю…";
  setErr("");
  const m = await ask("post", "/update", {});
  updateBtn.disabled = false;
  updateBtn.textContent = prev;
  if (!m.ok) { setErr((m.error && m.error.message) || "Обновление не установилось."); return; }
  await load();
};
seenBtn.onclick = async () => { setErr(""); await ask("post", "/seen", {}); await load(); };
document.getElementById("full-close").onclick = () => { document.getElementById("full").classList.remove("open"); document.getElementById("full-body").replaceChildren(); };
document.getElementById("full-html").onclick = () => { if (opened) openItem(opened, "html"); };
document.getElementById("full-video").onclick = () => { if (opened) openItem(opened, "video"); };
load();
send("ready");
</script></body></html>`;
}
//# sourceMappingURL=tab-page.js.map