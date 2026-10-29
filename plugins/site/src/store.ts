import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const KINDS = ["page", "post", "category", "template"] as const;
export type Kind = (typeof KINDS)[number];
export type Status = "draft" | "published";

export interface Seo {
  title: string;
  description: string;
  image: string;
  noindex: boolean;
}

export interface Doc {
  id: string;
  kind: Kind;
  title: string;
  slug: string;
  body: string;
  status: Status;
  loginRequired: boolean;
  categoryId: string | null;
  seo: Seo;
  createdAt: string;
  updatedAt: string;
}

export interface DocInput {
  id?: string;
  kind: Kind;
  title: string;
  slug: string;
  body?: string;
  loginRequired?: boolean;
  categoryId?: string | null;
  seo?: { title?: string | undefined; description?: string | undefined; image?: string | undefined; noindex?: boolean | undefined };
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class SiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteError";
  }
}

interface Row {
  id: string;
  kind: Kind;
  title: string;
  slug: string;
  body: string;
  status: Status;
  login_required: number;
  category_id: string | null;
  seo_title: string;
  seo_description: string;
  seo_image: string;
  noindex: number;
  created_at: string;
  updated_at: string;
}

/** SQLite database of the site: pages, posts, categories, templates. One file in the plugin data folder. */
export class SiteStore {
  private readonly db: DatabaseSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(`${dir}/site.db`);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        login_required INTEGER NOT NULL DEFAULT 0,
        category_id TEXT,
        seo_title TEXT NOT NULL DEFAULT '',
        seo_description TEXT NOT NULL DEFAULT '',
        seo_image TEXT NOT NULL DEFAULT '',
        noindex INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS docs_public_slug ON docs(slug) WHERE kind != 'template';
      CREATE UNIQUE INDEX IF NOT EXISTS docs_template_slug ON docs(slug) WHERE kind = 'template';
    `);
  }

  list(filter: { kind?: Kind; status?: Status } = {}): Doc[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.kind) {
      where.push("kind = ?");
      args.push(filter.kind);
    }
    if (filter.status) {
      where.push("status = ?");
      args.push(filter.status);
    }
    const sql = `SELECT * FROM docs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY title`;
    return (this.db.prepare(sql).all(...args) as unknown as Row[]).map(toDoc);
  }

  get(idOrSlug: string): Doc | undefined {
    const row = this.db.prepare("SELECT * FROM docs WHERE id = ? OR slug = ?").get(idOrSlug, idOrSlug) as unknown as Row | undefined;
    return row ? toDoc(row) : undefined;
  }

  write(input: DocInput): Doc {
    const title = input.title.trim();
    const slug = input.slug.trim();
    if (!title) throw new SiteError("title is required");
    if (!SLUG.test(slug)) throw new SiteError("slug must be lowercase words separated by hyphens");
    if (!KINDS.includes(input.kind)) throw new SiteError("kind must be page, post, category or template");
    if (input.categoryId) {
      const cat = this.db.prepare("SELECT kind FROM docs WHERE id = ?").get(input.categoryId) as unknown as { kind: string } | undefined;
      if (!cat || cat.kind !== "category") throw new SiteError("categoryId is not a category");
    }
    const now = new Date().toISOString();
    const existing = input.id ? (this.db.prepare("SELECT * FROM docs WHERE id = ?").get(input.id) as unknown as Row | undefined) : undefined;
    const taken = this.db.prepare("SELECT id FROM docs WHERE slug = ? AND id != ? AND (? = 'template') = (kind = 'template')").get(slug, existing?.id ?? "", input.kind) as unknown as { id: string } | undefined;
    if (taken) throw new SiteError(`slug ${slug} is already used`);
    const seo = {
      title: input.seo?.title ?? existing?.seo_title ?? "",
      description: input.seo?.description ?? existing?.seo_description ?? "",
      image: input.seo?.image ?? existing?.seo_image ?? "",
      noindex: input.seo?.noindex ?? existing?.noindex === 1,
    };
    if (existing) {
      this.db.prepare(
        `UPDATE docs SET kind=?, title=?, slug=?, body=?, login_required=?, category_id=?, seo_title=?, seo_description=?, seo_image=?, noindex=?, updated_at=? WHERE id=?`,
      ).run(input.kind, title, slug, input.body ?? existing.body, input.loginRequired ? 1 : 0, input.categoryId ?? null, seo.title, seo.description, seo.image, seo.noindex ? 1 : 0, now, existing.id);
      return this.get(existing.id)!;
    }
    const id = `doc_${randomBytes(6).toString("hex")}`;
    this.db.prepare(
      `INSERT INTO docs (id, kind, title, slug, body, status, login_required, category_id, seo_title, seo_description, seo_image, noindex, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.kind, title, slug, input.body ?? "", input.loginRequired ? 1 : 0, input.categoryId ?? null, seo.title, seo.description, seo.image, seo.noindex ? 1 : 0, now, now);
    return this.get(id)!;
  }

  setStatus(id: string, status: Status): Doc {
    const row = this.db.prepare("SELECT id FROM docs WHERE id = ?").get(id) as unknown as { id: string } | undefined;
    if (!row) throw new SiteError(`no record ${id}`);
    this.db.prepare("UPDATE docs SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
    return this.get(id)!;
  }

  close(): void {
    this.db.close();
  }

  /** What a visitor may see. A closed page keeps its title and hides the body. */
  published(slug: string): { doc: Doc; hidden: boolean } | undefined {
    const row = this.db.prepare("SELECT * FROM docs WHERE slug = ? AND status = 'published' AND kind != 'template'").get(slug) as unknown as Row | undefined;
    if (!row) return undefined;
    const doc = toDoc(row);
    if (doc.loginRequired) return { doc: { ...doc, body: "" }, hidden: true };
    return { doc, hidden: false };
  }
}

function toDoc(r: Row): Doc {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    slug: r.slug,
    body: r.body,
    status: r.status,
    loginRequired: r.login_required === 1,
    categoryId: r.category_id,
    seo: { title: r.seo_title, description: r.seo_description, image: r.seo_image, noindex: r.noindex === 1 },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
