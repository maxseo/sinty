import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/** Sidebar rows in the rights table. A new panel item stays hidden until a role is granted it. */
export const NAV_RESOURCES: { id: string; title: string }[] = [
  { id: "nav:chats", title: "Чаты вне проектов" },
  { id: "nav:projects", title: "Проекты" },
  { id: "nav:agents", title: "Агенты" },
  { id: "nav:board", title: "Канбан" },
  { id: "nav:calendar", title: "Календарь" },
  { id: "nav:plugins", title: "Плагины" },
  { id: "nav:skills", title: "Навыки" },
  { id: "nav:mcp", title: "MCP" },
  { id: "nav:staff", title: "Сотрудники" },
  { id: "nav:settings", title: "Настройки установки" },
];

export type AccessAction = "view" | "add" | "edit" | "delete";

export interface AccountUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatar: string;
  roleId: string;
  roleName: string;
  system: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface AccountRole {
  id: string;
  name: string;
  system: boolean;
}

export interface Grant {
  resource: string;
  view: boolean;
  add: boolean;
  edit: boolean;
  delete: boolean;
}

export class AccountError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_MS = 60 * 60 * 1000;

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

function passwordOk(password: string, stored: string): boolean {
  const [kind, salt, key] = stored.split("$");
  if (kind !== "scrypt" || !salt || !key) return false;
  const got = scryptSync(password, Buffer.from(salt, "base64url"), 32);
  const want = Buffer.from(key, "base64url");
  return got.length === want.length && timingSafeEqual(got, want);
}

function emailOf(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new AccountError("invalid_email", "Нужна обычная почта.");
  return email;
}

function passwordOf(raw: string): string {
  if (raw.length < 8 || raw.length > 200) throw new AccountError("invalid_password", "Пароль от 8 до 200 символов.");
  return raw;
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/**
 * People, roles and grants for one install. The machine token is not stored here.
 * A system role (the installing superadmin) always passes every check.
 */
export class Accounts {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        system INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        first_name TEXT NOT NULL DEFAULT '',
        last_name TEXT NOT NULL DEFAULT '',
        avatar TEXT NOT NULL DEFAULT '',
        role_id TEXT NOT NULL REFERENCES roles(id),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS grants (
        role_id TEXT NOT NULL REFERENCES roles(id),
        resource TEXT NOT NULL,
        can_view INTEGER NOT NULL DEFAULT 0,
        can_add INTEGER NOT NULL DEFAULT 0,
        can_edit INTEGER NOT NULL DEFAULT 0,
        can_delete INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (role_id, resource)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resets (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        expires_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  hasUsers(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM users LIMIT 1").get());
  }

  /** First person on this install. Refused once anyone exists. */
  setup(input: { email: string; password: string; firstName?: string; lastName?: string }): { user: AccountUser; token: string } {
    if (this.hasUsers()) throw new AccountError("already_setup", "Суперадмин уже создан.", 409);
    const roleId = id("rol");
    this.db.prepare("INSERT INTO roles (id, name, system) VALUES (?, ?, 1)").run(roleId, "Суперадмин");
    const user = this.insertUser({
      email: input.email,
      password: input.password,
      firstName: input.firstName ?? "",
      lastName: input.lastName ?? "",
      avatar: "",
      roleId,
      enabled: true,
    });
    return { user, token: this.openSession(user.id) };
  }

  login(email: string, password: string): { user: AccountUser; token: string } {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(emailOf(email)) as UserRow | undefined;
    if (!row || !row.enabled || !passwordOk(password, row.password_hash)) throw new AccountError("invalid_login", "Почта или пароль не подходят.", 401);
    return { user: this.publicUser(row), token: this.openSession(row.id) };
  }

  logout(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
  }

  userByToken(token: string): AccountUser | null {
    if (!token) return null;
    const now = Date.now();
    const row = this.db.prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.enabled = 1`,
    ).get(sha(token), now) as UserRow | undefined;
    return row ? this.publicUser(row) : null;
  }

  /** Stores a one-time link token. The same answer either way, so the form does not reveal who is registered. */
  forgot(email: string): string | null {
    let parsed: string;
    try {
      parsed = emailOf(email);
    } catch {
      return null;
    }
    const row = this.db.prepare("SELECT * FROM users WHERE email = ? AND enabled = 1").get(parsed) as UserRow | undefined;
    if (!row) return null;
    return this.resetToken(row.id);
  }

  /** Shown once to a superadmin. Mail is not configured, so this is how a person gets the link. */
  resetLink(userId: string): string {
    const row = this.userRow(userId);
    if (!row.enabled) throw new AccountError("disabled", "Выключенная учётка не получает ссылку.");
    return this.resetToken(row.id);
  }

  resetPassword(token: string, password: string): void {
    const next = passwordOf(password);
    const row = this.db.prepare("SELECT user_id, expires_at FROM resets WHERE token_hash = ?").get(sha(token)) as { user_id: string; expires_at: number } | undefined;
    if (!row || row.expires_at < Date.now()) throw new AccountError("invalid_reset", "Ссылка недействительна или уже использована.", 400);
    this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(next), row.user_id);
    this.db.prepare("DELETE FROM resets WHERE token_hash = ?").run(sha(token));
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id);
  }

  /** Operator fallback when the person cannot open the panel. */
  setPassword(email: string, password: string): void {
    const row = this.db.prepare("SELECT id FROM users WHERE email = ?").get(emailOf(email)) as { id: string } | undefined;
    if (!row) throw new AccountError("not_found", "Такой почты нет.", 404);
    this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(passwordOf(password)), row.id);
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.id);
  }

  listUsers(): AccountUser[] {
    return (this.db.prepare("SELECT * FROM users ORDER BY created_at").all() as unknown as UserRow[]).map((r) => this.publicUser(r));
  }

  listRoles(): AccountRole[] {
    return (this.db.prepare("SELECT id, name, system FROM roles ORDER BY system DESC, name").all() as { id: string; name: string; system: number }[]).map((r) => ({
      id: r.id,
      name: r.name,
      system: r.system === 1,
    }));
  }

  createRole(name: string): AccountRole {
    const title = name.trim();
    if (!title || title.length > 80) throw new AccountError("invalid_name", "Название роли от 1 до 80 символов.");
    const roleId = id("rol");
    try {
      this.db.prepare("INSERT INTO roles (id, name, system) VALUES (?, ?, 0)").run(roleId, title);
    } catch {
      throw new AccountError("duplicate", "Роль с таким названием уже есть.", 409);
    }
    return { id: roleId, name: title, system: false };
  }

  deleteRole(roleId: string): void {
    const role = this.role(roleId);
    if (role.system) throw new AccountError("system_role", "Роль суперадмина нельзя удалить.");
    const used = this.db.prepare("SELECT 1 FROM users WHERE role_id = ?").get(roleId);
    if (used) throw new AccountError("role_in_use", "Сначала переведите сотрудников на другую роль.");
    this.db.prepare("DELETE FROM grants WHERE role_id = ?").run(roleId);
    this.db.prepare("DELETE FROM roles WHERE id = ?").run(roleId);
  }

  grants(roleId: string): Grant[] {
    this.role(roleId);
    return (this.db.prepare("SELECT resource, can_view, can_add, can_edit, can_delete FROM grants WHERE role_id = ?").all(roleId) as unknown as GrantRow[]).map(toGrant);
  }

  saveGrants(roleId: string, grants: Grant[]): void {
    const role = this.role(roleId);
    if (role.system) throw new AccountError("system_role", "Права суперадмина всегда полные и не редактируются.");
    const put = this.db.prepare(
      `INSERT INTO grants (role_id, resource, can_view, can_add, can_edit, can_delete) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (role_id, resource) DO UPDATE SET can_view = excluded.can_view, can_add = excluded.can_add, can_edit = excluded.can_edit, can_delete = excluded.can_delete`,
    );
    for (const g of grants) {
      if (!/^(nav:[a-z0-9_-]{1,40}|project:[A-Za-z0-9_-]{1,80})$/.test(g.resource)) throw new AccountError("invalid_resource", "Неизвестный пункт прав.");
      put.run(roleId, g.resource, bit(g.view), bit(g.add), bit(g.edit), bit(g.delete));
    }
  }

  createUser(input: { email: string; password: string; firstName?: string; lastName?: string; avatar?: string; roleId: string; enabled?: boolean }): AccountUser {
    this.role(input.roleId);
    return this.insertUser({
      email: input.email,
      password: input.password,
      firstName: input.firstName ?? "",
      lastName: input.lastName ?? "",
      avatar: avatarOf(input.avatar ?? ""),
      roleId: input.roleId,
      enabled: input.enabled !== false,
    });
  }

  updateUser(userId: string, patch: { firstName?: string; lastName?: string; avatar?: string; roleId?: string; enabled?: boolean; password?: string }): AccountUser {
    const row = this.userRow(userId);
    if (patch.roleId) this.role(patch.roleId);
    if (rowIsSystem(this, row) && patch.enabled === false) this.guardLastSuper(row.id);
    if (rowIsSystem(this, row) && patch.roleId && patch.roleId !== row.role_id) this.guardLastSuper(row.id);
    const roleId = patch.roleId ?? row.role_id;
    const enabled = patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0;
    this.db.prepare(
      "UPDATE users SET first_name = ?, last_name = ?, avatar = ?, role_id = ?, enabled = ? WHERE id = ?",
    ).run(
      (patch.firstName ?? row.first_name).slice(0, 80),
      (patch.lastName ?? row.last_name).slice(0, 80),
      patch.avatar === undefined ? row.avatar : avatarOf(patch.avatar),
      roleId,
      enabled,
      row.id,
    );
    if (patch.password) this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(passwordOf(patch.password)), row.id);
    if (!enabled) this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.id);
    return this.publicUser(this.userRow(userId));
  }

  deleteUser(userId: string): void {
    const row = this.userRow(userId);
    if (rowIsSystem(this, row)) this.guardLastSuper(row.id);
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.id);
    this.db.prepare("DELETE FROM resets WHERE user_id = ?").run(row.id);
    this.db.prepare("DELETE FROM users WHERE id = ?").run(row.id);
  }

  user(userId: string): AccountUser {
    return this.publicUser(this.userRow(userId));
  }

  roleIsSystem(roleId: string): boolean {
    return this.role(roleId).system === 1;
  }

  /** What the panel may show this person. A system role gets every box. */
  capabilities(user: AccountUser): Record<string, Grant> {
    const out: Record<string, Grant> = {};
    for (const n of NAV_RESOURCES) out[n.id] = { resource: n.id, view: false, add: false, edit: false, delete: false };
    if (user.system) {
      for (const k of Object.keys(out)) out[k] = { resource: k, view: true, add: true, edit: true, delete: true };
      return out;
    }
    for (const g of this.grants(user.roleId)) out[g.resource] = g;
    return out;
  }

  allows(user: AccountUser, resource: string, action: AccessAction): boolean {
    if (user.system) return true;
    const row = this.db.prepare("SELECT can_view, can_add, can_edit, can_delete FROM grants WHERE role_id = ? AND resource = ?").get(user.roleId, resource) as GrantRow | undefined;
    if (!row) return false;
    if (action === "view") return row.can_view === 1;
    if (action === "add") return row.can_add === 1;
    if (action === "edit") return row.can_edit === 1;
    return row.can_delete === 1;
  }

  private guardLastSuper(userId: string): void {
    const n = this.db.prepare(
      `SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.system = 1 AND u.enabled = 1 AND u.id != ?`,
    ).get(userId) as { n: number };
    if (n.n < 1) throw new AccountError("last_superadmin", "Последнего суперадмина нельзя удалить, выключить или снять с этой роли.");
  }

  private resetToken(userId: string): string {
    const token = randomBytes(24).toString("base64url");
    this.db.prepare("INSERT INTO resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha(token), userId, Date.now() + RESET_MS);
    return token;
  }

  private openSession(userId: string): string {
    const token = `snu_${randomBytes(24).toString("base64url")}`;
    this.db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha(token), userId, Date.now() + SESSION_MS);
    return token;
  }

  private insertUser(input: { email: string; password: string; firstName: string; lastName: string; avatar: string; roleId: string; enabled: boolean }): AccountUser {
    const userId = id("usr");
    try {
      this.db.prepare(
        "INSERT INTO users (id, email, password_hash, first_name, last_name, avatar, role_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(userId, emailOf(input.email), hashPassword(passwordOf(input.password)), input.firstName.slice(0, 80), input.lastName.slice(0, 80), input.avatar, input.roleId, input.enabled ? 1 : 0, new Date().toISOString());
    } catch (e) {
      if (e instanceof AccountError) throw e;
      throw new AccountError("duplicate", "Сотрудник с этой почтой уже есть.", 409);
    }
    return this.publicUser(this.userRow(userId));
  }

  private userRow(userId: string): UserRow {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
    if (!row) throw new AccountError("not_found", "Сотрудник не найден.", 404);
    return row;
  }

  private role(roleId: string): { id: string; system: number } {
    const row = this.db.prepare("SELECT id, system FROM roles WHERE id = ?").get(roleId) as { id: string; system: number } | undefined;
    if (!row) throw new AccountError("not_found", "Роль не найдена.", 404);
    return row;
  }

  private publicUser(row: UserRow): AccountUser {
    const role = this.db.prepare("SELECT name, system FROM roles WHERE id = ?").get(row.role_id) as { name: string; system: number };
    return {
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      avatar: row.avatar,
      roleId: row.role_id,
      roleName: role?.name ?? "",
      system: role?.system === 1,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
    };
  }
}

function rowIsSystem(accounts: Accounts, row: UserRow): boolean {
  return accounts.listUsers().some((u) => u.id === row.id && u.system);
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  first_name: string;
  last_name: string;
  avatar: string;
  role_id: string;
  enabled: number;
  created_at: string;
}

interface GrantRow {
  resource: string;
  can_view: number;
  can_add: number;
  can_edit: number;
  can_delete: number;
}

function toGrant(row: GrantRow): Grant {
  return { resource: row.resource, view: row.can_view === 1, add: row.can_add === 1, edit: row.can_edit === 1, delete: row.can_delete === 1 };
}

function bit(v: boolean): number {
  return v ? 1 : 0;
}

function avatarOf(value: string): string {
  if (value.length > 150_000) throw new AccountError("avatar_too_big", "Аватар больше 150 КБ.");
  return value;
}
