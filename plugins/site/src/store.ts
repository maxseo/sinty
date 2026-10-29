import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseLayout, SiteError, type Block } from "./layout.js";
export { SiteError };

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
  layout: Block[];
  /** The one page served at the site root, with no address after the domain. */
  home: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DocInput {
  id?: string;
  kind: Kind;
  title: string;
  slug?: string;
  /** The single front page. It has no public address. */
  home?: boolean;
  body?: string;
  loginRequired?: boolean;
  categoryId?: string | null;
  seo?: { title?: string | undefined; description?: string | undefined; image?: string | undefined; noindex?: boolean | undefined };
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
  layout: string;
  is_home: number;
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
    const cols = this.db.prepare("PRAGMA table_info(docs)").all() as unknown as { name: string }[];
    if (!cols.some((c) => c.name === "layout")) this.db.exec("ALTER TABLE docs ADD COLUMN layout TEXT NOT NULL DEFAULT '[]'");
    const cols2 = this.db.prepare("PRAGMA table_info(docs)").all() as unknown as { name: string }[];
    if (!cols2.some((c) => c.name === "is_home")) this.db.exec("ALTER TABLE docs ADD COLUMN is_home INTEGER NOT NULL DEFAULT 0");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS docs_one_home ON docs(is_home) WHERE is_home = 1");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS visitors (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        visitor_id TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        email INTEGER NOT NULL DEFAULT 1,
        google INTEGER NOT NULL DEFAULT 0,
        telegram INTEGER NOT NULL DEFAULT 0,
        yandex INTEGER NOT NULL DEFAULT 0,
        vk INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO login_settings (id) VALUES (1);
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        page_slug TEXT NOT NULL,
        fields TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
    `);
  }

  /** A visitor form. fields are what the client typed, including where to write (email, telegram). status pending means the agent has not sent the notice yet. */
  addRequest(pageSlug: string, fields: Record<string, string>): RequestRow {
    const page = this.published(pageSlug, true);
    if (!page) throw new SiteError("no such page");
    const clean: Record<string, string> = {};
    for (const key of ["name", "email", "phone", "telegram", "message"]) {
      const value = (fields[key] ?? "").trim();
      if (!value) continue;
      if (value.length > 2000) throw new SiteError(`${key} is too long`);
      clean[key] = value;
    }
    if (!Object.keys(clean).length) throw new SiteError("the form is empty");
    const id = `req_${randomBytes(6).toString("hex")}`;
    const createdAt = new Date().toISOString();
    this.db.prepare("INSERT INTO requests (id, page_slug, fields, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(id, pageSlug, JSON.stringify(clean), createdAt);
    return { id, pageSlug, fields: clean, status: "pending", createdAt };
  }

  requests(status?: "pending" | "sent"): RequestRow[] {
    const rows = (status
      ? this.db.prepare("SELECT * FROM requests WHERE status = ? ORDER BY created_at DESC").all(status)
      : this.db.prepare("SELECT * FROM requests ORDER BY created_at DESC").all()) as unknown as { id: string; page_slug: string; fields: string; status: string; created_at: string }[];
    return rows.map(toRequest);
  }

  setRequestStatus(id: string, status: "pending" | "sent"): RequestRow {
    const row = this.db.prepare("SELECT id FROM requests WHERE id = ?").get(id);
    if (!row) throw new SiteError(`no request ${id}`);
    this.db.prepare("UPDATE requests SET status = ? WHERE id = ?").run(status, id);
    return toRequest(this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as unknown as { id: string; page_slug: string; fields: string; status: string; created_at: string });
  }

  loginSettings(): LoginSettings {
    const row = this.db.prepare("SELECT email, google, telegram, yandex, vk FROM login_settings WHERE id = 1").get() as unknown as Record<string, number>;
    return { email: row.email === 1, google: row.google === 1, telegram: row.telegram === 1, yandex: row.yandex === 1, vk: row.vk === 1 };
  }

  setLoginSettings(next: { email?: boolean | undefined; google?: boolean | undefined; telegram?: boolean | undefined; yandex?: boolean | undefined; vk?: boolean | undefined }): LoginSettings {
    const cur = this.loginSettings();
    const merged = { ...cur };
    for (const key of ["email", "google", "telegram", "yandex", "vk"] as const) {
      if (typeof next[key] === "boolean") merged[key] = next[key];
    }
    this.db.prepare("UPDATE login_settings SET email=?, google=?, telegram=?, yandex=?, vk=? WHERE id=1").run(merged.email ? 1 : 0, merged.google ? 1 : 0, merged.telegram ? 1 : 0, merged.yandex ? 1 : 0, merged.vk ? 1 : 0);
    return merged;
  }

  /** Email and password of a visitor. Returns a session token. The hash never leaves the database. */
  registerVisitor(email: string, password: string): string {
    if (!this.loginSettings().email) throw new SiteError("email login is off");
    const addr = normalizeEmail(email);
    if (password.length < 8) throw new SiteError("password must be at least 8 characters");
    const taken = this.db.prepare("SELECT id FROM visitors WHERE email = ?").get(addr);
    if (taken) throw new SiteError("this email is already registered");
    const id = `vis_${randomBytes(6).toString("hex")}`;
    this.db.prepare("INSERT INTO visitors (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)").run(id, addr, hashPassword(password), new Date().toISOString());
    return this.openSession(id);
  }

  loginVisitor(email: string, password: string): string {
    if (!this.loginSettings().email) throw new SiteError("email login is off");
    const row = this.db.prepare("SELECT id, password_hash FROM visitors WHERE email = ?").get(normalizeEmail(email)) as unknown as { id: string; password_hash: string } | undefined;
    if (!row || !checkPassword(password, row.password_hash)) throw new SiteError("email or password is wrong");
    return this.openSession(row.id);
  }

  visitorFromToken(token: string): { id: string; email: string } | undefined {
    if (!token) return undefined;
    const row = this.db.prepare(
      "SELECT v.id, v.email FROM sessions s JOIN visitors v ON v.id = s.visitor_id WHERE s.token = ? AND s.expires_at > ?",
    ).get(token, new Date().toISOString()) as unknown as { id: string; email: string } | undefined;
    return row;
  }

  endSession(token: string): void {
    if (token) this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }

  openChat(id: string): { id: string; sessionId: string | null } {
    const existing = this.db.prepare("SELECT id, session_id FROM chats WHERE id = ?").get(id) as unknown as { id: string; session_id: string | null } | undefined;
    if (existing) return { id: existing.id, sessionId: existing.session_id };
    this.db.prepare("INSERT INTO chats (id, session_id, created_at) VALUES (?, NULL, ?)").run(id, new Date().toISOString());
    return { id, sessionId: null };
  }

  setChatSession(id: string, sessionId: string): void {
    this.db.prepare("UPDATE chats SET session_id = ? WHERE id = ?").run(sessionId, id);
  }

  addChatMessage(chatId: string, role: "visitor" | "agent", body: string): void {
    const text = body.trim();
    if (!text) throw new SiteError("message is empty");
    if (text.length > 4000) throw new SiteError("message is too long");
    this.db.prepare("INSERT INTO chat_messages (id, chat_id, role, body, created_at) VALUES (?, ?, ?, ?, ?)").run(`msg_${randomBytes(6).toString("hex")}`, chatId, role, text, new Date().toISOString());
  }

  chatMessages(chatId: string): { role: "visitor" | "agent"; body: string; createdAt: string }[] {
    return (this.db.prepare("SELECT role, body, created_at FROM chat_messages WHERE chat_id = ? ORDER BY created_at").all(chatId) as unknown as { role: string; body: string; created_at: string }[]).map((r) => ({
      role: r.role === "agent" ? "agent" : "visitor",
      body: r.body,
      createdAt: r.created_at,
    }));
  }

  chats(): { id: string; sessionId: string | null; createdAt: string; last: string }[] {
    return (this.db.prepare(
      `SELECT c.id, c.session_id, c.created_at, (SELECT body FROM chat_messages m WHERE m.chat_id = c.id ORDER BY created_at DESC LIMIT 1) AS last
       FROM chats c ORDER BY c.created_at DESC LIMIT 50`,
    ).all() as unknown as { id: string; session_id: string | null; created_at: string; last: string | null }[]).map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      createdAt: r.created_at,
      last: r.last ?? "",
    }));
  }

  visitors(): { id: string; email: string; createdAt: string }[] {
    return (this.db.prepare("SELECT id, email, created_at FROM visitors ORDER BY created_at").all() as unknown as { id: string; email: string; created_at: string }[]).map((r) => ({ id: r.id, email: r.email, createdAt: r.created_at }));
  }

  private openSession(visitorId: string): string {
    const token = randomBytes(24).toString("hex");
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare("INSERT INTO sessions (token, visitor_id, expires_at) VALUES (?, ?, ?)").run(token, visitorId, expires);
    return token;
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

  /** The published front page, if there is one. */
  homePage(signedIn = false): { doc: Doc; hidden: boolean } | undefined {
    const row = this.db.prepare("SELECT * FROM docs WHERE is_home = 1 AND status = 'published'").get() as unknown as Row | undefined;
    if (!row) return undefined;
    const doc = toDoc(row);
    if (doc.loginRequired && !signedIn) return { doc: { ...doc, body: "", layout: [] }, hidden: true };
    return { doc, hidden: false };
  }

  write(input: DocInput): Doc {
    const title = input.title.trim();
    const home = input.home === true;
    const slug = home ? "" : (input.slug ?? "").trim();
    if (!title) throw new SiteError("Укажите название");
    if (home && input.kind !== "page") throw new SiteError("Главная может быть только страницей");
    if (!home && !SLUG.test(slug)) throw new SiteError("Адрес: латиница маленькими буквами, слова через дефис. Пример: o-nas");
    if (!KINDS.includes(input.kind)) throw new SiteError("kind must be page, post, category or template");
    if (input.categoryId) {
      const cat = this.db.prepare("SELECT kind FROM docs WHERE id = ?").get(input.categoryId) as unknown as { kind: string } | undefined;
      if (!cat || cat.kind !== "category") throw new SiteError("categoryId is not a category");
    }
    const now = new Date().toISOString();
    const existing = input.id ? (this.db.prepare("SELECT * FROM docs WHERE id = ?").get(input.id) as unknown as Row | undefined) : undefined;
    if (home) {
      const other = this.db.prepare("SELECT id FROM docs WHERE is_home = 1 AND id != ?").get(existing?.id ?? "") as unknown as { id: string } | undefined;
      if (other) throw new SiteError("Главная уже есть. Она одна.");
    } else {
      const taken = this.db.prepare("SELECT id FROM docs WHERE slug = ? AND id != ? AND (? = 'template') = (kind = 'template')").get(slug, existing?.id ?? "", input.kind) as unknown as { id: string } | undefined;
      if (taken) throw new SiteError("Такой адрес уже занят");
    }
    const seo = {
      title: input.seo?.title ?? existing?.seo_title ?? "",
      description: input.seo?.description ?? existing?.seo_description ?? "",
      image: input.seo?.image ?? existing?.seo_image ?? "",
      noindex: input.seo?.noindex ?? existing?.noindex === 1,
    };
    if (existing) {
      this.db.prepare(
        `UPDATE docs SET kind=?, title=?, slug=?, body=?, login_required=?, category_id=?, seo_title=?, seo_description=?, seo_image=?, noindex=?, is_home=?, updated_at=? WHERE id=?`,
      ).run(input.kind, title, slug, input.body ?? existing.body, input.loginRequired ? 1 : 0, input.categoryId ?? null, seo.title, seo.description, seo.image, seo.noindex ? 1 : 0, home ? 1 : 0, now, existing.id);
      return this.get(existing.id)!;
    }
    const id = `doc_${randomBytes(6).toString("hex")}`;
    this.db.prepare(
      `INSERT INTO docs (id, kind, title, slug, body, status, login_required, category_id, seo_title, seo_description, seo_image, noindex, is_home, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.kind, title, slug, input.body ?? "", input.loginRequired ? 1 : 0, input.categoryId ?? null, seo.title, seo.description, seo.image, seo.noindex ? 1 : 0, home ? 1 : 0, now, now);
    return this.get(id)!;
  }

  setStatus(id: string, status: Status): Doc {
    const row = this.db.prepare("SELECT id FROM docs WHERE id = ?").get(id) as unknown as { id: string } | undefined;
    if (!row) throw new SiteError(`no record ${id}`);
    this.db.prepare("UPDATE docs SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
    return this.get(id)!;
  }

  /** Replace the constructor tree. Does not change publish status. */
  setLayout(id: string, layout: unknown): Doc {
    const doc = this.get(id);
    if (!doc) throw new SiteError(`no record ${id}`);
    const tree = parseLayout(layout);
    this.db.prepare("UPDATE docs SET layout = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(tree), new Date().toISOString(), doc.id);
    return this.get(doc.id)!;
  }

  /** Append one block that pulls a template in. The template is not copied, so editing it updates every page that uses it. */
  useTemplate(id: string, templateId: string): Doc {
    const doc = this.get(id);
    const tpl = this.get(templateId);
    if (!doc) throw new SiteError(`no record ${id}`);
    if (!tpl || tpl.kind !== "template") throw new SiteError("templateId is not a template");
    const layout = [...doc.layout, { id: `b_${randomBytes(4).toString("hex")}`, rows: [{ id: `r_${randomBytes(4).toString("hex")}`, cols: [{ id: `c_${randomBytes(4).toString("hex")}`, widgets: [{ id: `w_${randomBytes(4).toString("hex")}`, type: "dynamic_block" as const, props: { templateId: tpl.id } }] }] }] }];
    this.db.prepare("UPDATE docs SET layout = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(layout), new Date().toISOString(), doc.id);
    return this.get(doc.id)!;
  }

  close(): void {
    this.db.close();
  }

  /** What a visitor may see. A closed page keeps its title and hides the body. */
  published(slug: string, signedIn = false): { doc: Doc; hidden: boolean } | undefined {
    const row = this.db.prepare("SELECT * FROM docs WHERE slug = ? AND status = 'published' AND kind != 'template'").get(slug) as unknown as Row | undefined;
    if (!row) return undefined;
    const doc = toDoc(row);
    if (doc.loginRequired && !signedIn) return { doc: { ...doc, body: "", layout: [] }, hidden: true };
    return { doc, hidden: false };
  }
}

export interface RequestRow {
  id: string;
  pageSlug: string;
  fields: Record<string, string>;
  status: "pending" | "sent";
  createdAt: string;
}

function toRequest(r: { id: string; page_slug: string; fields: string; status: string; created_at: string }): RequestRow {
  let fields: Record<string, string> = {};
  try {
    const parsed = JSON.parse(r.fields) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") fields[k] = v;
    }
  } catch {
    fields = {};
  }
  return { id: r.id, pageSlug: r.page_slug, fields, status: r.status === "sent" ? "sent" : "pending", createdAt: r.created_at };
}

export interface LoginSettings {
  email: boolean;
  google: boolean;
  telegram: boolean;
  yandex: boolean;
  vk: boolean;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email: string): string {
  const addr = email.trim().toLowerCase();
  if (!EMAIL.test(addr) || addr.length > 200) throw new SiteError("email is not valid");
  return addr;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function checkPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = scryptSync(password, Buffer.from(saltHex, "hex"), 32);
  const expected = Buffer.from(hashHex, "hex");
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

function parseStored(raw: string | undefined): Block[] {
  if (!raw) return [];
  try {
    return parseLayout(JSON.parse(raw) as unknown);
  } catch {
    return [];
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
    layout: parseStored(r.layout),
    home: r.is_home === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
