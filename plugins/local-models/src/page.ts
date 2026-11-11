export function tabHtml(): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Локальные модели</title>
<style>
:root { color-scheme: light; --bg:#f4f4f5; --panel:#fff; --text:#050505; --muted:#71717a; --line:rgba(0,0,0,.1); --hover:#f4f4f5; --accent:#74ff2a; --accent-ink:#111; --danger:#b91c1c; --ok:#15803d; --wait:#b45309; --bad:#b91c1c; --off:#71717a; }
[data-theme="dark"] { color-scheme: dark; --bg:#050505; --panel:#141414; --text:#fff; --muted:#a1a1aa; --line:rgba(255,255,255,.12); --hover:#1c1c1c; --accent:#74ff2a; --accent-ink:#111; --danger:#fca5a5; --ok:#4ade80; --wait:#fbbf24; --bad:#f87171; --off:#a1a1aa; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 Inter, system-ui, sans-serif; }
.wrap { padding: 16px 18px 28px; max-width: 960px; }
.banner { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; margin-bottom: 14px; }
h1 { font-size: 22px; letter-spacing: -0.02em; margin: 0 0 8px; }
h2 { font-size: 16px; margin: 0 0 8px; }
.muted, .small { color: var(--muted); }
.small { font-size: 12px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 14px; margin: 12px 0; }
.row { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin: 10px 0; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
input, select, button { font: inherit; color: var(--text); }
input, select { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 7px 10px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.btn, .ghost, .btn.primary, .btn.danger { border-radius: 10px; padding: 7px 12px; cursor: pointer; border: 1px solid var(--line); background: var(--panel); }
.btn.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; font-weight: 650; }
.btn.danger { color: var(--danger); }
.ghost { font-size: 12px; margin: 4px 6px 0 0; }
.dot { width: 10px; height: 10px; border-radius: 99px; display: inline-block; background: var(--off); margin-right: 8px; }
.dot.ok { background: var(--ok); }
.dot.wait { background: var(--wait); }
.dot.bad { background: var(--bad); }
.pill { font-size: 12px; border-radius: 99px; padding: 3px 8px; border: 1px solid var(--line); }
.pill.ok { color: var(--ok); }
.pill.wait { color: var(--wait); }
.pill.bad { color: var(--bad); }
.error { color: var(--bad); }
#log { white-space: pre-wrap; font: 12px/1.4 ui-monospace, monospace; background: var(--bg); border-radius: 10px; padding: 10px; max-height: 240px; overflow: auto; border: 1px solid var(--line); }
.bar-wrap { height: 8px; background: var(--line); border-radius: 99px; overflow: hidden; margin-top: 6px; }
#bar { height: 8px; width: 0; background: var(--accent); }
.dlg { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: grid; place-items: center; }
.dlg[hidden], [hidden] { display: none !important; }
.dlg .card { max-width: 420px; }
@media (max-width: 700px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>Локальные модели</h1>
  <div class="banner" id="banner">Сервер моделей запускается на машине процесса Sinty, не в браузере и не на другом устройстве. В Docker localhost — сеть контейнера.</div>
  <p class="muted">Один управляемый llama-server. Зелёный статус — API готов отвечать (GET /health = 200), а не просто «процесс существует».</p>
  <p class="error" id="error" hidden></p>
  <div class="card row">
    <div><span id="run-dot" class="dot off"></span><b id="run-label">сервер остановлен</b><p id="run-err" class="error small" hidden></p></div>
    <button type="button" class="btn" id="refresh">Обновить</button>
  </div>
  <div class="card">
    <h2>Движок llama-server</h2>
    <p class="muted small" id="engine-note"></p>
    <label>Путь к llama-server на машине Sinty
      <input id="engine-path" placeholder="C:\\...\\llama-server.exe или /usr/local/bin/llama-server">
    </label>
    <p class="muted small" id="engine-meta"></p>
    <div id="suggestions"></div>
    <div class="actions"><button type="button" class="btn primary" id="save-engine">Сохранить путь и проверить</button></div>
  </div>
  <div class="card">
    <h2>Добавить модель</h2>
    <label>Название (необязательно) <input id="import-title"></label>
    <p class="muted small">Импорт копирует файл в хранилище плагина ($SINTY_HOME/data/local-models). «Путь на сервере» не копирует большие файлы и работает только если процесс Sinty видит этот путь.</p>
    <div class="actions">
      <label class="btn">Загрузить GGUF<input id="pick-files" type="file" accept=".gguf" multiple hidden></label>
    </div>
    <div id="prog" hidden>
      <div id="prog-text" class="small muted"></div>
      <div class="bar-wrap"><div id="bar"></div></div>
      <button type="button" class="btn" id="cancel-up">Отменить загрузку</button>
    </div>
    <div class="grid">
      <label>Существующий путь на машине Sinty <input id="server-path" placeholder="D:\\models\\qwen.gguf"></label>
      <label>mmproj (необязательно) <input id="mmproj-path" placeholder="абсолютный путь к mmproj.gguf"></label>
    </div>
    <div class="actions"><button type="button" class="btn" id="register">Зарегистрировать путь</button></div>
  </div>
  <div id="models"></div>
  <div class="card">
    <h2>Журнал сервера</h2>
    <pre id="log">Журнал появится после запуска.</pre>
  </div>
</div>
<div class="dlg" id="dlg" hidden>
  <div class="card">
    <p id="dlg-text"></p>
    <div class="actions">
      <button type="button" class="btn" id="dlg-no">Отмена</button>
      <button type="button" class="btn primary" id="dlg-yes">Подтвердить</button>
    </div>
  </div>
</div>
<script>

const PROTO = "tab/1";
let reqId = 1;
const pending = new Map();
function call(op, path, body) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parent.postMessage({ sinty: PROTO, id, op, path, ...(body ? { body } : {}) }, "*");
  });
}
const get = (path) => call("get", path);
const post = (path, body) => call("post", path, body);
function uploadFile(file, onProgress, ac) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    if (ac) ac.addEventListener("abort", () => parent.postMessage({ sinty: PROTO, id, op: "upload-cancel" }, "*"));
    parent.postMessage({ sinty: PROTO, id, op: "upload", path: "/uploads", filename: file.name, size: file.size, file }, "*");
  });
}
function catalogBind(payload) { return call("catalog-bind", "/bindings", payload); }
function catalogUnbind(route) { return call("catalog-unbind", "/bindings", { route }); }
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.sinty !== PROTO) return;
  if (m.op === "init" || m.op === "theme") {
    document.documentElement.dataset.theme = m.theme === "dark" ? "dark" : "light";
    if (m.op === "init") load();
    return;
  }
  if (m.op === "upload-progress") {
    const p = pending.get(m.id);
    if (p && p.onProgress) p.onProgress(m.loaded, m.total);
    return;
  }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m.data);
  else p.reject(new Error(m.error && m.error.message ? m.error.message : "ошибка"));
});
parent.postMessage({ sinty: PROTO, op: "ready" }, "*");

const $ = (id) => document.getElementById(id);
function statusClass(s) {
  if (s === "ready") return "ok";
  if (s === "loading") return "wait";
  if (s === "error") return "bad";
  return "off";
}
function statusLabel(s) {
  return { ready: "готова", loading: "загружается", error: "ошибка", stopped: "остановлена" }[s] || s || "остановлена";
}
let state = null;
let confirmAction = null;

async function load() {
  try {
    state = await get("/state");
    render();
  } catch (e) {
    $("error").textContent = e.message;
    $("error").hidden = false;
  }
}

function render() {
  $("error").hidden = true;
  $("banner").textContent = state.location;
  const inst = state.instance;
  const st = inst ? inst.status : "stopped";
  $("run-dot").className = "dot " + statusClass(st);
  $("run-label").textContent = inst ? (statusLabel(st) + " · порт " + inst.port) : "сервер остановлен";
  if (inst && inst.lastError) { $("run-err").textContent = inst.lastError; $("run-err").hidden = false; }
  else { $("run-err").hidden = true; }
  $("engine-path").value = (state.engine && state.engine.binaryPath) || "";
  $("engine-meta").textContent = state.engine && state.engine.version ? state.engine.version : "Бинарник ещё не выбран.";
  $("engine-note").textContent = state.engineInstallNote;
  const sug = $("suggestions");
  sug.innerHTML = "";
  (state.suggestedBinaries || []).forEach((p) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "ghost"; b.textContent = p;
    b.onclick = () => { $("engine-path").value = p; };
    sug.appendChild(b);
  });
  const box = $("models");
  box.innerHTML = "";
  if (!state.assets.length) {
    box.innerHTML = "<p class='muted'>Модели ещё не добавлены.</p>";
  }
  state.assets.forEach((asset) => {
    const profiles = state.profiles.filter((p) => p.assetId === asset.id);
    const profile = profiles[0];
    const binding = state.bindings.find((b) => b.assetId === asset.id);
    const running = inst && profile && inst.profileId === profile.id;
    const card = document.createElement("div");
    card.className = "card";
    const files = asset.files.map((f) => f.name + (f.role === "mmproj" ? " (mmproj)" : f.role === "shard" ? " (часть)" : "")).join(", ");
    const srcLabel = asset.source === "path" ? "Путь на сервере, без копии" : "Импортировано в хранилище Sinty";
    const pillCls = running ? statusClass(st) : "off";
    const pillText = running ? statusLabel(st) : "в каталоге не требуется запуск";
    const arch = asset.architecture ? ("<p class='muted small'>Архитектура: " + asset.architecture + (asset.contextLength ? " · контекст модели " + asset.contextLength : "") + "</p>") : "";
    card.innerHTML = "<div class='row head'><div><b></b><div class='muted small' data-files></div><div class='muted small'>" + srcLabel + "</div></div><span class='pill " + pillCls + "'>" + pillText + "</span></div>" + arch + "<div class='grid'><label>Контекст <input data-k='ctxSize' type='number' min='0' max='1048576'></label><label>GPU-слои <input data-k='gpuLayers' placeholder='auto'></label><label>KV-кеш K <select data-k='cacheTypeK'><option>f16</option><option>f32</option><option>bf16</option><option>q8_0</option><option>q4_0</option><option>q5_0</option></select></label><label>KV-кеш V <select data-k='cacheTypeV'><option>f16</option><option>f32</option><option>bf16</option><option>q8_0</option><option>q4_0</option><option>q5_0</option></select></label><label>Параллельность <input data-k='parallel' type='number' min='-1' max='256'></label><label>Порт (0 = свободный) <input data-k='port' type='number' min='0' max='65535'></label></div><p class='muted small'>Host всегда 127.0.0.1. Temperature и sampling задаются в профиле агента, не здесь.</p><div class='actions'></div><p class='bind muted small'></p>";
        card.querySelector("b").textContent = asset.title;
    card.querySelector("[data-files]").textContent = files;
    if (profile) {
      card.querySelector('[data-k="ctxSize"]').value = profile.ctxSize;
      card.querySelector('[data-k="gpuLayers"]').value = profile.gpuLayers;
      card.querySelector('[data-k="cacheTypeK"]').value = profile.cacheTypeK;
      card.querySelector('[data-k="cacheTypeV"]').value = profile.cacheTypeV;
      card.querySelector('[data-k="parallel"]').value = profile.parallel;
      card.querySelector('[data-k="port"]').value = profile.port;
    }
    const actions = card.querySelector(".actions");
    const addBtn = (label, cls, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = cls; b.textContent = label; b.onclick = fn; actions.appendChild(b);
    };
    const fields = () => {
      const o = { id: profile && profile.id, assetId: asset.id, name: (profile && profile.name) || "По умолчанию" };
      card.querySelectorAll("[data-k]").forEach((el) => { o[el.getAttribute("data-k")] = el.value; });
      return o;
    };
    addBtn("Сохранить профиль", "btn", () => run(() => post("/profiles", fields())));
    if (running && (st === "ready" || st === "loading")) {
      addBtn("Остановить", "btn danger", () => ask("Остановить сервер? Активные запросы будут прерваны.", () => post("/instance/stop", { confirm: true })));
    } else {
      addBtn("Запустить", "btn primary", async () => {
        await post("/profiles", fields());
        const r = await post("/instance/start", { profileId: profile.id });
        if (r.provider && binding) {
          try { await catalogBind({ route: binding.catalogRoute, provider: r.provider }); } catch (e) { $("error").textContent = "Сервер запущен, но каталог не обновлён: " + e.message; $("error").hidden = false; }
        }
        await load();
        await journal();
      });
    }
    if (binding) {
      card.querySelector(".bind").textContent = "В каталоге агентов: " + binding.catalogRoute + " (остановка сервер не удаляет запись).";
      addBtn("Убрать из каталога", "btn", () => ask("Убрать запись из каталога агентов? Файлы останутся.", async () => {
        const r = await post("/catalog/unbind", { route: binding.catalogRoute });
        if (r.needsCatalogUnbind) await catalogUnbind(binding.catalogRoute);
      }));
    } else if (profile) {
      addBtn("Добавить в каталог", "btn", async () => {
        const alias = prompt("Идентификатор в каталоге (латиница):", asset.id);
        if (!alias) return;
        const r = await post("/catalog/bind", { profileId: profile.id, alias });
        await catalogBind({ route: r.route, provider: r.provider });
        await load();
      });
    }
    addBtn("Удалить", "btn", () => ask("Удалить запись модели? Импортированные файлы будут удалены, пути на месте — нет.", () => post("/assets/delete", { id: asset.id })));
    box.appendChild(card);
  });
}

async function run(fn) {
  $("error").hidden = true;
  try { await fn(); await load(); } catch (e) { $("error").textContent = e.message; $("error").hidden = false; }
}
function ask(text, fn) {
  $("dlg-text").textContent = text;
  $("dlg").hidden = false;
  confirmAction = fn;
}

async function journal() {
  try {
    const j = await get("/journal");
    $("log").textContent = j.text || "Журнал пуст.";
  } catch (e) {
    $("log").textContent = e.message;
  }
}

$("save-engine").onclick = () => run(() => post("/engine/select", { path: $("engine-path").value }));
$("refresh").onclick = () => run(async () => { await load(); await journal(); });
$("pick-files").onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  const ac = new AbortController();
  $("prog").hidden = false;
  $("cancel-up").onclick = () => ac.abort();
  try {
    const ids = [];
    for (const file of files) {
      $("prog-text").textContent = "Загрузка " + file.name;
      const r = await uploadFile(file, (loaded, total) => {
        const pct = total ? Math.round(100 * loaded / total) : 0;
        $("bar").style.width = pct + "%";
        $("prog-text").textContent = file.name + " · " + pct + "%";
      }, ac);
      ids.push(r.uploadId || r.id);
    }
    await post("/imports/commit", { uploadIds: ids, title: $("import-title").value });
    $("import-title").value = "";
    await load();
  } catch (err) {
    $("error").textContent = err.message;
    $("error").hidden = false;
  } finally {
    $("prog").hidden = true;
    $("bar").style.width = "0";
  }
};
$("register").onclick = () => run(() => post("/paths/register", { path: $("server-path").value, title: $("import-title").value, mmprojPath: $("mmproj-path").value || undefined }));
$("dlg-no").onclick = () => { $("dlg").hidden = true; confirmAction = null; };
$("dlg-yes").onclick = async () => {
  const fn = confirmAction; confirmAction = null; $("dlg").hidden = true;
  if (fn) await run(fn);
};

</script>
</body>
</html>`;
}
