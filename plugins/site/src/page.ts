export { builderHtml } from "./builder-tail.js";

/** Admin lists. The iframe has no token; the harness bridge adds it to GET /docs. Text only, no HTML from records. */
export const TAB_CSP = ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"].join("; ");

/** Pages or the blog. A person creates the record here; widgets are added on Конструктор. */
export function tabHtml(which: "pages" | "blog"): string {
  const title = which === "pages" ? "Страницы" : "Блог";
  const listPath = which === "pages" ? "/docs" : "/blog-docs";
  const editPath = which === "pages" ? "/pages/edit" : "/blog/edit";
  const form = which === "pages"
    ? `<p id="err" class="muted"></p><form id="create"><label>Название<input name="title" id="title"></label><label>Ссылка<input name="slug" id="slug" placeholder="o-nas"></label><label>Meta title<input name="metaTitle"></label><label>Meta description<textarea name="metaDescription" rows="2"></textarea></label><label>Описание<textarea name="body" rows="4"></textarea></label><button type="button" id="go">Создать</button></form><p class="muted">Здесь только внутренние страницы. Главная — в конструкторе, пункт «Главная», без адреса. Ссылка: латиница через дефис, например o-nas. Дизайн страницы — в конструкторе, тип «Страница».</p>`
    : `<form id="cat" class="row"><input name="title" required placeholder="Название категории"><input name="slug" required placeholder="адрес категории" pattern="[a-z0-9]+(-[a-z0-9]+)*"><button>Создать категорию</button></form><form id="post" class="row"><input name="title" required placeholder="Название поста"><input name="slug" required placeholder="адрес поста" pattern="[a-z0-9]+(-[a-z0-9]+)*"><select name="categoryId" id="cats"></select><button>Создать пост</button></form><p class="muted">Сначала категория, потом пост. Черновик не виден на сайте, пока не нажмёте «Опубликовать».</p>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title>
<style>
body{margin:0;font:14px/1.45 system-ui,sans-serif;color:#1d1d1f;background:#fff}
h1{font-size:16px;margin:0;padding:12px 16px;border-bottom:1px solid #e5e5ea}
form,p{padding:0 16px}
form label{display:block;margin:8px 0}
form input,form textarea{display:block;width:100%;max-width:420px;box-sizing:border-box}
.row{display:flex;gap:8px;align-items:center;padding-top:12px}
ul{list-style:none;margin:12px 0 0;padding:0}
li{padding:8px 16px;border-bottom:1px solid #f0f0f2;display:flex;gap:8px;align-items:center}
.muted{color:#6e6e73;font-size:12px}
input,select,button{font:inherit}
button{cursor:pointer}
</style></head><body>
<h1>${title}</h1>
${form}
<ul id="list"></ul>
<script>
const blog = ${JSON.stringify(which === "blog")};
const send = (op, extra) => parent.postMessage(Object.assign({ sinty: "tab/1", op }, extra || {}), "*");
let n = 0; const wait = new Map();
addEventListener("message", (e) => { const m = e.data || {}; if (m.sinty !== "tab/1") return; if (typeof m.id === "number" && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
function ask(op, path, body) { const id = ++n; return new Promise((ok) => { wait.set(id, ok); send(op, { id, path, body }); }); }
let records = [];
function label(r) {
  const kind = r.home ? "главная" : r.kind === "category" ? "категория" : r.kind === "post" ? "пост" : "страница";
  const st = r.status === "published" ? "опубликовано" : "черновик";
  const addr = r.home ? "" : " · /" + r.slug;
  return r.title + " · " + kind + " · " + st + addr;
}
function draw() {
  const ul = document.getElementById("list");
  ul.textContent = "";
  const rows = records.filter((r) => blog ? r.kind === "post" || r.kind === "category" : r.kind === "page" && !r.home);
  if (!rows.length) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "Пока пусто."; ul.append(li); }
  for (const r of rows) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = label(r);
    const pub = document.createElement("button");
    pub.type = "button";
    pub.textContent = r.status === "published" ? "В черновик" : "Опубликовать";
    pub.onclick = () => setStatus(r, r.status === "published" ? "draft" : "published");
    li.append(span, pub);
    ul.append(li);
  }
  if (blog) {
    const sel = document.getElementById("cats");
    sel.textContent = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "без категории";
    sel.append(none);
    for (const c of records.filter((r) => r.kind === "category")) {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.title;
      sel.append(o);
    }
  }
}
async function reload() {
  const m = await ask("get", ${JSON.stringify(listPath)});
  records = (m.data && m.data.records) || [];
  draw();
}
function fail(m) {
  const el = document.getElementById("err");
  const text = (m && m.error && m.error.message) || "Не сохранилось. Обновите панель и попробуйте ещё раз.";
  if (el) el.textContent = text; else alert(text);
}
async function create(kind, form) {
  const fd = new FormData(form);
  const body = { action: "create", kind, title: fd.get("title") || "", slug: fd.get("slug") || "", body: fd.get("body") || "", metaTitle: fd.get("metaTitle") || "", metaDescription: fd.get("metaDescription") || "" };
  if (fd.get("categoryId")) body.categoryId = fd.get("categoryId");
  const err = document.getElementById("err");
  if (err) err.textContent = "";
  if (!String(body.title || "").trim()) { fail({ error: { message: "Укажите название" } }); return; }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(body.slug || ""))) { fail({ error: { message: "Ссылка: латиница маленькими буквами через дефис, например o-nas" } }); return; }
  const m = await Promise.race([ask("post", ${JSON.stringify(editPath)}, body), new Promise((ok) => setTimeout(() => ok({ ok: false, error: { message: "Панель не ответила. Обновите страницу харнеса (Ctrl+F5) и повторите." } }), 8000))]);
  if (!m.ok) { fail(m); return; }
  form.reset();
  await reload();
}
async function setStatus(r, status) {
  const m = await ask("post", ${JSON.stringify(editPath)}, { action: "status", id: r.id, status });
  if (!m.ok) { alert((m.error && m.error.message) || "не сохранилось"); return; }
  await reload();
}
const go = document.getElementById("go");
if (go) go.onclick = () => create("page", document.getElementById("create"));
document.getElementById("cat") && (document.getElementById("cat").onsubmit = (e) => { e.preventDefault(); create("category", e.target); });
document.getElementById("post") && (document.getElementById("post").onsubmit = (e) => { e.preventDefault(); create("post", e.target); });
reload();
send("ready");
</script></body></html>`;
}

