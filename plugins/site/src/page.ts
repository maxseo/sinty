/** Admin lists. The iframe has no token; the harness bridge adds it to GET /docs. Text only, no HTML from records. */
export const TAB_CSP = ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"].join("; ");

export function tabHtml(which: "pages" | "blog"): string {
  const title = which === "pages" ? "Страницы" : "Блог";
  const kinds = which === "pages" ? "page,template" : "post,category";
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
  if (!rows.length) ul.innerHTML = '<li class="muted">Пока пусто. Записи создаёт агент инструментами site.write и site.publish.</li>';
  for (const r of rows) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = r.title;
    const s = document.createElement("span");
    s.className = "muted";
    s.textContent = " · " + r.kind + " · " + r.status + " · /" + r.slug;
    b.onclick = () => { document.getElementById("body").textContent = r.body || "(пусто)"; };
    li.append(b, s);
    ul.append(li);
  }
});
send("ready");
</script></body></html>`;
}
