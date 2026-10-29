import { randomBytes } from "node:crypto";

export class SiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteError";
  }
}

export interface LayoutDoc {
  title: string;
  slug: string;
  updatedAt: string;
  layout: Block[];
  kind: string;
}

/** Widgets copied from the Syntet builder, only the ones the first site needs. */
export const WIDGET_TYPES = [
  "title", "text", "image", "icon", "button", "menu", "logo", "breadcrumbs",
  "slider", "post_list", "category_list", "cover", "description", "author", "date", "post_nav", "dynamic_block", "form",
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export interface Widget {
  id: string;
  type: WidgetType;
  props: Record<string, string>;
}

export interface Col {
  id: string;
  widgets: Widget[];
}

export interface Row {
  id: string;
  cols: Col[];
}

export interface Block {
  id: string;
  rows: Row[];
}

const nid = (p: string) => `${p}_${randomBytes(4).toString("hex")}`;

/** Accepts the agent's tree and fills missing ids. Rejects unknown widget types and oversized trees. */
export function parseLayout(raw: unknown): Block[] {
  if (!Array.isArray(raw)) throw new SiteError("layout must be a list of blocks");
  if (raw.length > 40) throw new SiteError("layout has too many blocks");
  return raw.map((block) => {
    const b = asRecord(block, "block");
    const rows = asArray(b.rows, "rows");
    if (rows.length > 12) throw new SiteError("a block has too many rows");
    return {
      id: str(b.id) || nid("b"),
      rows: rows.map((row) => {
        const r = asRecord(row, "row");
        const cols = asArray(r.cols, "cols");
        if (cols.length > 6) throw new SiteError("a row has too many columns");
        return {
          id: str(r.id) || nid("r"),
          cols: cols.map((col) => {
            const c = asRecord(col, "col");
            const widgets = asArray(c.widgets, "widgets");
            if (widgets.length > 20) throw new SiteError("a column has too many widgets");
            return { id: str(c.id) || nid("c"), widgets: widgets.map(parseWidget) };
          }),
        };
      }),
    };
  });
}

function parseWidget(raw: unknown): Widget {
  const w = asRecord(raw, "widget");
  const type = str(w.type);
  if (!(WIDGET_TYPES as readonly string[]).includes(type)) throw new SiteError(`unknown widget ${type || "(empty)"}`);
  const props: Record<string, string> = {};
  if (w.props !== undefined) {
    const p = asRecord(w.props, "props");
    const keys = Object.keys(p);
    if (keys.length > 20) throw new SiteError("a widget has too many props");
    for (const key of keys) {
      if (key.length > 40) throw new SiteError("prop name is too long");
      const value = p[key];
      if (typeof value !== "string") throw new SiteError(`prop ${key} must be text`);
      if (value.length > 4000) throw new SiteError(`prop ${key} is too long`);
      props[key] = value;
    }
  }
  return { id: str(w.id) || nid("w"), type: type as WidgetType, props };
}

function asRecord(v: unknown, name: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new SiteError(`${name} must be an object`);
  return v as Record<string, unknown>;
}
function asArray(v: unknown, name: string): unknown[] {
  if (!Array.isArray(v)) throw new SiteError(`${name} must be a list`);
  return v;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** One level of template expansion. A template that points at another template is shown as a note, not followed. */
export function renderLayout(layout: Block[], doc: LayoutDoc, lookup: (id: string) => LayoutDoc | undefined, lists: { posts: LayoutDoc[]; categories: LayoutDoc[] }): string {
  return layout.map((block) => `<section>${block.rows.map((row) => `<div class="row">${row.cols.map((col) => `<div class="col">${col.widgets.map((w) => widgetHtml(w, doc, lookup, lists, true)).join("")}</div>`).join("")}</div>`).join("")}</section>`).join("");
}

function widgetHtml(w: Widget, doc: LayoutDoc, lookup: (id: string) => LayoutDoc | undefined, lists: { posts: LayoutDoc[]; categories: LayoutDoc[] }, expand: boolean): string {
  const p = w.props;
  switch (w.type) {
    case "title":
      return `<h2>${esc(p.text || doc.title)}</h2>`;
    case "text":
    case "description":
      return `<p>${esc(p.text || "")}</p>`;
    case "image":
    case "cover":
    case "logo":
      return p.src ? `<img alt="${esc(p.alt || "")}" src="${esc(p.src)}">` : "";
    case "icon":
      return `<span class="icon">${esc(p.name || "")}</span>`;
    case "button":
      return `<p><a href="${esc(p.href || "#")}">${esc(p.text || "Кнопка")}</a></p>`;
    case "menu":
      return `<nav>${(p.items || "").split(",").map((s) => `<span>${esc(s.trim())}</span>`).join(" · ")}</nav>`;
    case "breadcrumbs":
      return `<p class="muted">${esc(doc.title)}</p>`;
    case "slider":
      return (p.images || "").split(",").filter(Boolean).map((src) => `<img alt="" src="${esc(src.trim())}">`).join("");
    case "author":
      return `<p>${esc(p.name || "")}</p>`;
    case "date":
      return `<p class="muted">${esc(p.value || doc.updatedAt.slice(0, 10))}</p>`;
    case "post_list":
      return `<ul>${lists.posts.map((d) => `<li>${esc(d.title)}</li>`).join("")}</ul>`;
    case "category_list":
      return `<ul>${lists.categories.map((d) => `<li>${esc(d.title)}</li>`).join("")}</ul>`;
    case "post_nav":
      return `<p class="muted">Навигация по записям</p>`;
    case "form": {
      const names = (p.fields || "name,email,phone,telegram,message").split(",").map((s) => s.trim()).filter((s) => /^(name|email|phone|telegram|message)$/.test(s));
      const labels: Record<string, string> = { name: "Имя", email: "Почта", phone: "Телефон", telegram: "Telegram", message: "Сообщение" };
      const inputs = names.map((name) => name === "message"
        ? `<p><label>${labels[name]}<br><textarea name="${name}" rows="4"></textarea></label></p>`
        : `<p><label>${labels[name]}<br><input name="${name}" ${name === "email" ? 'type="email"' : ""}></label></p>`).join("");
      return `<form method="post" action="/p/site/form"><input type="hidden" name="slug" value="${esc(doc.slug)}">${inputs}<p><button>Отправить</button></p></form>`;
    }
    case "dynamic_block": {
      if (!expand) return `<p class="muted">Шаблон</p>`;
      const tpl = p.templateId ? lookup(p.templateId) : undefined;
      if (!tpl || tpl.kind !== "template") return `<p class="muted">Шаблон не найден</p>`;
      return tpl.layout.map((block) => block.rows.map((row) => row.cols.map((col) => col.widgets.map((inner) => widgetHtml(inner, doc, lookup, lists, false)).join("")).join("")).join("")).join("");
    }
    default:
      return "";
  }
}
