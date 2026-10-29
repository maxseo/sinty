import { definePlugin, ToolError, z } from "@sinty/sdk";
import { renderLayout } from "./layout.js";
import { TAB_CSP, tabHtml } from "./page.js";
import { KINDS, SiteError, SiteStore, type Doc, type Kind, type Status } from "./store.js";

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
      description: "Replace the constructor tree of a record. layout is a list of blocks; each block has rows; each row has cols; each col has widgets. A widget is { type, props }. Types: title, text, image, icon, button, menu, logo, breadcrumbs, slider, post_list, category_list, cover, description, author, date, post_nav, dynamic_block. dynamic_block props.templateId is a template record id. Does not publish.",
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

    ctx.http({ method: "GET", path: "/tab/pages", public: true, surface: "pages", handler: () => html(tabHtml("pages")) });
    ctx.http({ method: "GET", path: "/tab/blog", public: true, surface: "blog", handler: () => html(tabHtml("blog")) });
    ctx.http({ method: "GET", path: "/tab/builder", public: true, surface: "builder", handler: () => html(tabHtml("builder")) });
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
      handler: (_req, { params }) => {
        const found = store.published(params.slug ?? "");
        if (!found) return json({ error: { code: "not_found", message: "no such page" } }, 404);
        return json({ ...found.doc, hidden: found.hidden });
      },
    });
    ctx.http({
      method: "GET",
      path: "/view/:slug",
      public: true,
      handler: (_req, { params }) => {
        const found = store.published(params.slug ?? "");
        if (!found) return new Response("Страница не найдена", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
        const body = found.hidden ? "<p>Эта страница откроется после входа.</p>" : pageBody(store, found.doc);
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

function viewHtml(title: string, body: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:24px;color:#1d1d1f}.row{display:flex;gap:16px}.col{flex:1}.muted{color:#6e6e73}img{max-width:100%}</style><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

export type { Status };
