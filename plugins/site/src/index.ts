import { randomBytes } from "node:crypto";
import { definePlugin, runTurn, ToolError, z } from "@sinty/sdk";
import { renderLayout } from "./layout.js";
import { TAB_CSP, tabHtml } from "./page.js";
import { KINDS, SiteError, SiteStore, type Doc, type Kind, type LoginSettings, type Status } from "./store.js";

const kind = z.enum(KINDS);
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const seo = z.object({ title: z.string().optional(), description: z.string().optional(), image: z.string().optional(), noindex: z.boolean().optional() }).optional();

export default definePlugin({
  name: "site",
  setup(ctx) {
    const store = new SiteStore(ctx.paths.data);
    const fail = (e: unknown): never => {
      throw new ToolError("site_error", e instanceof SiteError ? e.message : String(e));
    };

    ctx.tool({
      name: "site.list",
      description: "List site records. kind: page (landing), post, category, template. status: draft or published. Omit either to list all.",
      input: z.object({ kind: kind.optional(), status: z.enum(["draft", "published"]).optional() }),
      sideEffects: "read",
      idempotent: true,
      async run(args) {
        return { content: { records: store.list({ ...(args.kind ? { kind: args.kind } : {}), ...(args.status ? { status: args.status } : {}) }) } };
      },
    });
    ctx.tool({
      name: "site.read",
      description: "Read one site record by id or slug, draft or published.",
      input: z.object({ id: z.string().min(1) }),
      sideEffects: "read",
      idempotent: true,
      async run(args) {
        const doc = store.get(args.id);
        if (!doc) throw new ToolError("not_found", `no site record ${args.id}`);
        return { content: doc };
      },
    });
    ctx.tool({
      name: "site.write",
      description: "Create or update a page, post, category or template. Pass id to update. A new record stays a draft until site.publish. slug is the public address, lowercase with hyphens. categoryId is the id of a category, for a post.",
      input: z.object({
        id: z.string().optional(),
        kind,
        title: z.string().min(1),
        slug: z.string().min(1),
        body: z.string().optional(),
        loginRequired: z.boolean().optional(),
        categoryId: z.string().nullable().optional(),
        seo,
      }),
      sideEffects: "write",
      idempotent: true,
      async run(args) {
        try {
          return {
            content: store.write({
              kind: args.kind,
              title: args.title,
              slug: args.slug,
              ...(args.id ? { id: args.id } : {}),
              ...(args.body !== undefined ? { body: args.body } : {}),
              ...(args.loginRequired !== undefined ? { loginRequired: args.loginRequired } : {}),
              ...(args.categoryId !== undefined ? { categoryId: args.categoryId } : {}),
              ...(args.seo ? { seo: args.seo } : {}),
            }),
          };
        } catch (e) {
          return fail(e);
        }
      },
    });
    ctx.tool({
      name: "site.publish",
      description: "Set a record to published (visible on the site) or draft (hidden).",
      input: z.object({ id: z.string().min(1), status: z.enum(["draft", "published"]) }),
      sideEffects: "write",
      idempotent: true,
      async run(args) {
        try {
          return { content: store.setStatus(args.id, args.status) };
        } catch (e) {
          return fail(e);
        }
      },
    });
    ctx.tool({
      name: "site.layout",
      description: "Replace the constructor tree of a record. layout is a list of blocks; each block has rows; each row has cols; each col has widgets. A widget is { type, props }. Types: title, text, image, icon, button, menu, logo, breadcrumbs, slider, post_list, category_list, cover, description, author, date, post_nav, dynamic_block, form. form props.fields is a comma list of name, email, phone, telegram, message. dynamic_block props.templateId is a template record id. Does not publish.",
      input: z.object({ id: z.string().min(1), layout: z.array(z.unknown()) }),
      sideEffects: "write",
      idempotent: true,
      async run(args) {
        try {
          return { content: store.setLayout(args.id, args.layout) };
        } catch (e) {
          return fail(e);
        }
      },
    });
    ctx.tool({
      name: "site.template",
      description: "Insert a template into a page or post as one dynamic block. Later edits of the template show up on every record that uses it.",
      input: z.object({ id: z.string().min(1), templateId: z.string().min(1) }),
      sideEffects: "write",
      idempotent: false,
      async run(args) {
        try {
          return { content: store.useTemplate(args.id, args.templateId) };
        } catch (e) {
          return fail(e);
        }
      },
    });
    ctx.tool({
      name: "site.login",
      description: "Turn visitor sign-in methods on or off: email (password), google, telegram, yandex, vk. OAuth keys are harness secrets, never stored in the site database. Only email and password can sign a visitor in today.",
      input: z.object({ email: z.boolean().optional(), google: z.boolean().optional(), telegram: z.boolean().optional(), yandex: z.boolean().optional(), vk: z.boolean().optional() }),
      sideEffects: "write",
      idempotent: true,
      async run(args) {
        return { content: store.setLoginSettings(args) };
      },
    });
    ctx.tool({
      name: "site.requests",
      description: "List form submissions. Each record has the client's fields (name, email, phone, telegram, message) and status pending or sent. pending means the notice is not sent yet. Send it with a harness connector (mail or Telegram) to the address in those fields, then call site.request with status sent. This tool does not send anything.",
      input: z.object({ status: z.enum(["pending", "sent"]).optional() }),
      sideEffects: "read",
      idempotent: true,
      async run(args) {
        return { content: { requests: store.requests(args.status) } };
      },
    });
    ctx.tool({
      name: "site.request",
      description: "Mark a form submission sent after the connector delivered the notice, or pending if it still needs sending.",
      input: z.object({ id: z.string().min(1), status: z.enum(["pending", "sent"]) }),
      sideEffects: "write",
      idempotent: true,
      async run(args) {
        try {
          return { content: store.setRequestStatus(args.id, args.status) };
        } catch (e) {
          return fail(e);
        }
      },
    });
    ctx.tool({
      name: "site.chats",
      description: "List visitor chats on the public site. Each row has the harness session id, so the same thread is also in the harness chat list.",
      input: z.object({}),
      sideEffects: "read",
      idempotent: true,
      async run() {
        return { content: { chats: store.chats() } };
      },
    });
    ctx.tool({
      name: "site.visitors",
      description: "List visitor accounts: id, email, createdAt. No passwords.",
      input: z.object({}),
      sideEffects: "read",
      idempotent: true,
      async run() {
        return { content: { visitors: store.visitors(), login: store.loginSettings() } };
      },
    });

    ctx.http({ method: "GET", path: "/tab/pages", public: true, surface: "pages", handler: () => html(tabHtml("pages")) });
    ctx.http({ method: "GET", path: "/tab/blog", public: true, surface: "blog", handler: () => html(tabHtml("blog")) });
    ctx.http({ method: "GET", path: "/tab/builder", public: true, surface: "builder", handler: () => html(tabHtml("builder")) });
    ctx.http({ method: "GET", path: "/tab/login", public: true, surface: "login", handler: () => html(loginTab()) });
    ctx.http({ method: "GET", path: "/tab/requests", public: true, surface: "requests", handler: () => html(requestsTab()) });
    ctx.http({ method: "GET", path: "/tab/chats", public: true, surface: "chats", handler: () => html(chatsTab()) });
    ctx.http({
      method: "GET",
      path: "/chats",
      surface: "chats",
      access: "view",
      handler: () => json({ chats: store.chats() }),
    });
    ctx.http({
      method: "GET",
      path: "/chat",
      public: true,
      handler: () => new Response(chatPage(), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'", "cache-control": "no-store" } }),
    });
    ctx.http({
      method: "GET",
      path: "/chat/messages",
      public: true,
      handler: (req) => json({ messages: store.chatMessages(chatId(req)) }),
    });
    ctx.http({
      method: "POST",
      path: "/chat/send",
      public: true,
      handler: async (req, { signal }) => {
        const form = await req.formData();
        const text = String(form.get("text") ?? "").trim();
        const id = chatId(req);
        const fresh = !req.headers.get("cookie")?.includes("site_chat=");
        const chat = store.openChat(id);
        if (!text) return json({ error: { code: "empty", message: "message is empty" } }, 400);
        let sessionId = chat.sessionId ?? undefined;
        if (sessionId && !(await ctx.agent.getSession(sessionId))) sessionId = undefined;
        if (!sessionId) {
          sessionId = (await ctx.agent.createSession({ title: "Сайт: посетитель", metadata: { via: "site", chatId: id } })).id;
          store.setChatSession(id, sessionId);
        }
        store.addChatMessage(id, "visitor", text);
        let answer = "Агент сейчас не ответил. Напишите ещё раз чуть позже.";
        try {
          const outcome = await runTurn(ctx.agent, sessionId, `Сообщение посетителя с сайта:\n${text}`, { signal, channel: "web", idempotencyKey: `site:${id}:${randomBytes(8).toString("hex")}` });
          if (outcome.text.trim()) answer = outcome.text.trim();
        } catch (e) {
          ctx.log.warn("site chat turn failed", e instanceof Error ? e.message : "");
        }
        store.addChatMessage(id, "agent", answer);
        const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        if (fresh) headers.set("set-cookie", `site_chat=${id}; HttpOnly; Path=/p/site; SameSite=Lax; Max-Age=31536000`);
        return new Response(JSON.stringify({ messages: store.chatMessages(id) }), { headers });
      },
    });
    ctx.http({
      method: "GET",
      path: "/requests",
      surface: "requests",
      access: "view",
      handler: () => json({ requests: store.requests() }),
    });
    ctx.http({
      method: "POST",
      path: "/form",
      public: true,
      handler: async (req) => {
        const form = await req.formData();
        const fields: Record<string, string> = {};
        for (const key of ["name", "email", "phone", "telegram", "message"]) fields[key] = String(form.get(key) ?? "");
        try {
          store.addRequest(String(form.get("slug") ?? ""), fields);
          return html(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Заявка</title><p>Заявка принята.</p>`);
        } catch (e) {
          return html(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Заявка</title><p>${e instanceof SiteError ? "Проверьте поля и попробуйте ещё раз." : "Не получилось отправить."}</p>`);
        }
      },
    });
    ctx.http({
      method: "GET",
      path: "/settings",
      surface: "login",
      access: "view",
      handler: () => json({ login: store.loginSettings(), visitors: store.visitors().length }),
    });
    ctx.http({
      method: "GET",
      path: "/docs",
      surface: "pages",
      access: "view",
      handler: (req) => {
        const q = new URL(req.url, "http://x").searchParams;
        const k = q.get("kind");
        const status = q.get("status");
        return json({ records: store.list({ ...(k && (KINDS as readonly string[]).includes(k) ? { kind: k as Kind } : {}), ...(status === "draft" || status === "published" ? { status } : {}) }) });
      },
    });
    ctx.http({
      method: "GET",
      path: "/public",
      public: true,
      handler: () => json({ pages: store.list({ status: "published" }).filter((d) => d.kind !== "template").map((d) => ({ slug: d.slug, title: d.title, kind: d.kind, loginRequired: d.loginRequired })) }),
    });
    ctx.http({
      method: "GET",
      path: "/public/:slug",
      public: true,
      handler: (req, { params }) => {
        const found = store.published(params.slug ?? "", signedIn(store, req));
        if (!found) return json({ error: { code: "not_found", message: "no such page" } }, 404);
        return json({ ...found.doc, hidden: found.hidden });
      },
    });
    ctx.http({
      method: "GET",
      path: "/login",
      public: true,
      handler: (req) => html(loginForm(new URL(req.url, "http://x").searchParams.get("error") ?? "", store.loginSettings())),
    });
    ctx.http({
      method: "POST",
      path: "/session",
      public: true,
      handler: async (req) => {
        const form = await req.formData();
        const email = String(form.get("email") ?? "");
        const password = String(form.get("password") ?? "");
        try {
          const token = String(form.get("action") ?? "") === "register" ? store.registerVisitor(email, password) : store.loginVisitor(email, password);
          return new Response(null, { status: 303, headers: { location: "/p/site/login?ok=1", "set-cookie": cookie(token, 30 * 24 * 3600) } });
        } catch (e) {
          const code = e instanceof SiteError ? "bad" : "error";
          return new Response(null, { status: 303, headers: { location: `/p/site/login?error=${code}` } });
        }
      },
    });
    ctx.http({
      method: "POST",
      path: "/logout",
      public: true,
      handler: (req) => {
        store.endSession(tokenOf(req));
        return new Response(null, { status: 303, headers: { location: "/p/site/login", "set-cookie": cookie("", 0) } });
      },
    });
    ctx.http({
      method: "GET",
      path: "/view/:slug",
      public: true,
      handler: (req, { params }) => {
        const found = store.published(params.slug ?? "", signedIn(store, req));
        if (!found) return new Response("Страница не найдена", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
        const body = found.hidden ? `<p>Эта страница откроется после входа. <a href="/p/site/login">Войти</a></p>` : pageBody(store, found.doc);
        return html(viewHtml(found.doc.title, body));
      },
    });
  },
});

const html = (body: string): Response => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": TAB_CSP, "cache-control": "no-store" } });

function pageBody(store: SiteStore, doc: Doc): string {
  if (doc.layout.length) {
    const published = store.list({ status: "published" });
    return renderLayout(doc.layout, doc, (id) => store.get(id), {
      posts: published.filter((d) => d.kind === "post"),
      categories: published.filter((d) => d.kind === "category"),
    });
  }
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return `<pre style="white-space:pre-wrap">${esc(doc.body)}</pre>`;
}

function tokenOf(req: Request): string {
  return req.headers.get("cookie")?.match(/(?:^|;\s*)site_visitor=([a-f0-9]+)/)?.[1] ?? "";
}
function signedIn(store: SiteStore, req: Request): boolean {
  return Boolean(store.visitorFromToken(tokenOf(req)));
}
function cookie(token: string, maxAge: number): string {
  return `site_visitor=${token}; HttpOnly; Path=/p/site; SameSite=Lax; Max-Age=${maxAge}`;
}

function chatId(req: Request): string {
  return req.headers.get("cookie")?.match(/(?:^|;\s*)site_chat=([a-f0-9]+)/)?.[1] ?? randomBytes(8).toString("hex");
}

function chatPage(): string {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Чат</title>
<style>body{font:16px/1.45 system-ui,sans-serif;margin:0;display:flex;flex-direction:column;height:100vh}#log{flex:1;overflow:auto;padding:16px}form{display:flex;gap:8px;padding:12px;border-top:1px solid #e5e5ea}.me{text-align:right}.agent{color:#1d1d1f}p{margin:8px 0}</style>
<div id="log"></div>
<form id="f"><input name="text" required maxlength="4000" style="flex:1" placeholder="Сообщение"><button>Отправить</button></form>
<script>
const log = document.getElementById("log");
function draw(rows) {
  log.textContent = "";
  for (const m of rows) {
    const p = document.createElement("p");
    p.className = m.role === "visitor" ? "me" : "agent";
    p.textContent = m.body;
    log.append(p);
  }
  log.scrollTop = log.scrollHeight;
}
async function load() { const r = await fetch("/p/site/chat/messages"); draw((await r.json()).messages || []); }
document.getElementById("f").onsubmit = async (e) => {
  e.preventDefault();
  const text = new FormData(e.target).get("text");
  e.target.reset();
  const r = await fetch("/p/site/chat/send", { method: "POST", body: new URLSearchParams({ text }) });
  draw((await r.json()).messages || []);
};
load();
</script>`;
}

function chatsTab(): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Чаты</title>
<style>body{margin:0;font:14px/1.45 system-ui,sans-serif}h1{font-size:16px;margin:0;padding:12px 16px;border-bottom:1px solid #e5e5ea}li{padding:8px 16px;border-bottom:1px solid #f0f0f2;list-style:none}.muted{color:#6e6e73}</style></head><body>
<h1>Чаты сайта</h1><ul id="list"></ul>
<p class="muted" style="padding:0 16px">Ответ пишет агент в сессии харнеса. Страница для гостя: /p/site/chat</p>
<script>
const send = (op, extra) => parent.postMessage(Object.assign({ sinty: "tab/1", op }, extra || {}), "*");
let n = 0; const wait = new Map();
addEventListener("message", (e) => { const m = e.data || {}; if (m.sinty !== "tab/1") return; if (typeof m.id === "number" && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
function ask(path) { const id = ++n; return new Promise((ok) => { wait.set(id, ok); send("get", { id, path }); }); }
ask("/chats").then((m) => {
  const rows = (m.data && m.data.chats) || [];
  const ul = document.getElementById("list");
  if (!rows.length) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "Пока пусто."; ul.append(li); return; }
  for (const r of rows) { const li = document.createElement("li"); li.textContent = (r.last || "пусто").slice(0, 80); ul.append(li); }
});
send("ready");
</script></body></html>`;
}

function requestsTab(): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Заявки</title>
<style>body{margin:0;font:14px/1.45 system-ui,sans-serif}h1{font-size:16px;margin:0;padding:12px 16px;border-bottom:1px solid #e5e5ea}li{padding:8px 16px;border-bottom:1px solid #f0f0f2;list-style:none}.muted{color:#6e6e73}</style></head><body>
<h1>Заявки</h1><ul id="list"></ul>
<p class="muted" style="padding:0 16px">Письмо и Telegram отправляет агент через коннектор харнеса, на почту и в чат из заявки.</p>
<script>
const send = (op, extra) => parent.postMessage(Object.assign({ sinty: "tab/1", op }, extra || {}), "*");
let n = 0; const wait = new Map();
addEventListener("message", (e) => { const m = e.data || {}; if (m.sinty !== "tab/1") return; if (typeof m.id === "number" && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
function ask(path) { const id = ++n; return new Promise((ok) => { wait.set(id, ok); send("get", { id, path }); }); }
ask("/requests").then((m) => {
  const rows = (m.data && m.data.requests) || [];
  const ul = document.getElementById("list");
  if (!rows.length) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "Пока пусто."; ul.append(li); return; }
  for (const r of rows) {
    const li = document.createElement("li");
    const f = r.fields || {};
    li.textContent = (f.name || "без имени") + " · " + (f.email || f.telegram || "") + " · " + r.status;
    ul.append(li);
  }
});
send("ready");
</script></body></html>`;
}

function loginForm(error: string, settings: LoginSettings): string {
  const note = error === "bad" ? "<p>Почта или пароль не подошли, либо такая почта уже есть.</p>" : "";
  const providers = [
    settings.google ? "Google" : "",
    settings.telegram ? "Telegram" : "",
    settings.yandex ? "Яндекс" : "",
    settings.vk ? "VK" : "",
  ].filter(Boolean);
  const later = providers.length ? `<p class="muted">${providers.join(", ")}: ключ хранится в харнесе, кнопка входа будет следующим шагом.</p>` : "";
  const form = settings.email
    ? `<form method="post" action="/p/site/session"><p><input name="email" type="email" required placeholder="почта"></p><p><input name="password" type="password" required minlength="8" placeholder="пароль"></p><p><button name="action" value="login">Войти</button> <button name="action" value="register">Создать аккаунт</button></p></form><form method="post" action="/p/site/logout"><button>Выйти</button></form>`
    : "<p>Вход по почте выключен.</p>";
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Вход</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:24px}.muted{color:#6e6e73}</style><h1>Вход на сайт</h1>${note}${form}${later}`;
}

function loginTab(): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Вход</title>
<style>body{margin:0;font:14px/1.45 system-ui,sans-serif;padding:16px}.muted{color:#6e6e73}</style></head><body>
<h1>Вход посетителей</h1>
<p id="state" class="muted">Загрузка…</p>
<p class="muted">Переключатели ставит агент инструментом site.login. Ключи Google, Telegram, Яндекса и VK в базу сайта не пишутся.</p>
<script>
const send = (op, extra) => parent.postMessage(Object.assign({ sinty: "tab/1", op }, extra || {}), "*");
let n = 0; const wait = new Map();
addEventListener("message", (e) => {
  const m = e.data || {};
  if (m.sinty !== "tab/1") return;
  if (typeof m.id === "number" && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
});
function ask(path) { const id = ++n; return new Promise((ok) => { wait.set(id, ok); send("get", { id, path }); }); }
ask("/settings").then((m) => {
  const login = (m.data && m.data.login) || {};
  const on = (k) => login[k] ? "вкл" : "выкл";
  document.getElementById("state").textContent = "Почта " + on("email") + ", Google " + on("google") + ", Telegram " + on("telegram") + ", Яндекс " + on("yandex") + ", VK " + on("vk") + ". Посетителей: " + ((m.data && m.data.visitors) || 0);
});
send("ready");
</script></body></html>`;
}

function viewHtml(title: string, body: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:24px;color:#1d1d1f}.row{display:flex;gap:16px}.col{flex:1}.muted{color:#6e6e73}img{max-width:100%}</style><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

export type { Status };
