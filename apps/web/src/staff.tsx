import { useEffect, useState } from "preact/hooks";
import { api } from "./api.js";
import { useAccess } from "./access.js";

interface UserRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatar: string;
  roleId: string;
  roleName: string;
  system: boolean;
  enabled: boolean;
}

interface RoleRow {
  id: string;
  name: string;
  system: boolean;
}

interface Grant {
  resource: string;
  view: boolean;
  add: boolean;
  edit: boolean;
  delete: boolean;
}

interface ProjectRow {
  id: string;
  name: string;
}

type Tab = "people" | "roles" | "rights";

const ACTIONS = ["view", "add", "edit", "delete"] as const;
const ACTION_LABEL: Record<(typeof ACTIONS)[number], string> = { view: "Смотреть", add: "Добавлять", edit: "Править", delete: "Удалять" };
const TABS: { id: Tab; title: string }[] = [
  { id: "people", title: "Сотрудники" },
  { id: "roles", title: "Роли" },
  { id: "rights", title: "Права" },
];

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function StaffPage() {
  const [tab, setTab] = useState<Tab>("people");
  const [needed, setNeeded] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<{ needed: boolean }>("/v1/auth/setup").then((r) => setNeeded(r.needed)).catch(() => undefined);
  }, []);
  const pick = (next: Tab): void => {
    setError("");
    setTab(next);
  };
  return (
    <div class="settings-sheet staff">
      <h3>Сотрудники</h3>
      {needed ? <Setup onDone={() => setNeeded(false)} /> : (
        <>
          <div class="seg-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} class={tab === t.id ? "on" : ""} onClick={() => pick(t.id)}>{t.title}</button>
            ))}
          </div>
          {error && <p class="error">{error}</p>}
          {tab === "people" && <People onError={setError} />}
          {tab === "roles" && <Roles onError={setError} />}
          {tab === "rights" && <Rights onError={setError} />}
        </>
      )}
    </div>
  );
}

function Setup({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [error, setError] = useState("");
  const save = async (e: Event): Promise<void> => {
    e.preventDefault();
    setError("");
    try {
      await api("/v1/auth/setup", { body: { email, password, firstName, lastName } });
      onDone();
    } catch (err) {
      setError(message(err));
    }
  };
  return (
    <form class="staff-card" onSubmit={save}>
      <p class="muted">Первый человек на этой установке становится суперадмином. Его нельзя удалить, пока он один.</p>
      <div class="staff-grid">
        <label class="field">Имя<input value={firstName} onInput={(e) => setFirstName(e.currentTarget.value)} /></label>
        <label class="field">Фамилия<input value={lastName} onInput={(e) => setLastName(e.currentTarget.value)} /></label>
        <label class="field">Почта<input type="email" value={email} onInput={(e) => setEmail(e.currentTarget.value)} /></label>
        <label class="field">Пароль<input type="password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} /></label>
      </div>
      <button type="submit" disabled={!email.trim() || password.length < 8}>Создать суперадмина</button>
      {error && <p class="error">{error}</p>}
    </form>
  );
}

function Avatar({ u }: { u: Pick<UserRow, "avatar" | "firstName" | "lastName" | "email"> }) {
  if (u.avatar) return <img class="staff-avatar" src={u.avatar} alt="" />;
  const letters = `${u.firstName[0] ?? ""}${u.lastName[0] ?? ""}`.trim() || u.email[0] || "?";
  return <span class="staff-avatar">{letters.toUpperCase()}</span>;
}

function People({ onError }: { onError: (s: string) => void }) {
  const { me, can } = useAccess();
  const isSuper = Boolean(me?.superadmin);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState("");
  const load = (): void => {
    void api<{ users: UserRow[] }>("/v1/accounts/users").then((r) => setUsers(r.users)).catch((e) => onError(message(e)));
    void api<{ roles: RoleRow[] }>("/v1/accounts/roles").then((r) => setRoles(r.roles)).catch((e) => onError(message(e)));
  };
  useEffect(load, []);
  const assignable = roles.filter((r) => isSuper || !r.system);
  const patch = (id: string, body: Record<string, unknown>): void => {
    onError("");
    void api(`/v1/accounts/users/${id}`, { method: "PATCH", body }).then(load).catch((e) => onError(message(e)));
  };
  const resetLink = (id: string): void => {
    onError("");
    void api<{ path: string }>(`/v1/accounts/users/${id}/reset-link`, { method: "POST" })
      .then((r) => setLink(`${location.origin}${location.pathname}${r.path}`))
      .catch((e) => onError(message(e)));
  };
  const remove = (u: UserRow): void => {
    if (!confirm(`Удалить ${u.email}?`)) return;
    onError("");
    void api(`/v1/accounts/users/${u.id}`, { method: "DELETE" }).then(load).catch((e) => onError(message(e)));
  };
  return (
    <div>
      <div class="staff-toolbar">
        <span class="muted small">{users.length} чел.</span>
        {can("nav:staff", "add") && <button type="button" onClick={() => setAdding(true)}>Добавить сотрудника</button>}
      </div>
      <table class="staff-table">
        <thead>
          <tr><th>Сотрудник</th><th>Роль</th><th class="center">Включён</th><th /></tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const locked = (u.system && !isSuper) || u.id === me?.user?.id;
            const editable = can("nav:staff", "edit") && !(u.system && !isSuper);
            return (
              <tr key={u.id}>
                <td>
                  <div class="staff-person">
                    <Avatar u={u} />
                    <div>
                      <b>{`${u.firstName} ${u.lastName}`.trim() || "—"}</b>
                      <div class="muted small">{u.email}</div>
                    </div>
                  </div>
                </td>
                <td>
                  {editable && !locked ? (
                    <select value={u.roleId} onChange={(e) => patch(u.id, { roleId: e.currentTarget.value })}>
                      {assignable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  ) : <span class="staff-role">{u.roleName}</span>}
                </td>
                <td class="center">
                  <input type="checkbox" checked={u.enabled} disabled={!editable || locked} onChange={(e) => patch(u.id, { enabled: e.currentTarget.checked })} />
                </td>
                <td class="staff-actions">
                  {editable && <button type="button" class="secondary sm" onClick={() => resetLink(u.id)}>Ссылка на пароль</button>}
                  {can("nav:staff", "delete") && !locked && <button type="button" class="danger sm" onClick={() => remove(u)}>Удалить</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {link && (
        <div class="staff-card">
          <p class="small muted">Ссылка для смены пароля. Действует один час и срабатывает один раз. Передайте её сотруднику.</p>
          <div class="cmd-line">
            <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" class="secondary" onClick={() => void navigator.clipboard?.writeText(link)}>Копировать</button>
          </div>
        </div>
      )}
      {adding && <AddPerson roles={assignable} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
    </div>
  );
}

function AddPerson({ roles, onClose, onSaved }: { roles: RoleRow[]; onClose: () => void; onSaved: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [roleId, setRoleId] = useState(roles.find((r) => !r.system)?.id ?? roles[0]?.id ?? "");
  const [avatar, setAvatar] = useState("");
  const [error, setError] = useState("");
  const save = async (e: Event): Promise<void> => {
    e.preventDefault();
    setError("");
    try {
      await api("/v1/accounts/users", { body: { email, password, firstName, lastName, roleId, ...(avatar ? { avatar } : {}) } });
      onSaved();
    } catch (err) {
      setError(message(err));
    }
  };
  return (
    <div class="overlay" onClick={onClose}>
      <form class="dialog" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <header class="dialog-head"><h3>Новый сотрудник</h3></header>
        <div class="staff-person">
          <Avatar u={{ avatar, firstName, lastName, email }} />
          <label class="secondary sm file-pick">
            Загрузить аватар
            <input type="file" class="file-hidden" accept="image/*" onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => setAvatar(typeof reader.result === "string" ? reader.result : "");
              reader.readAsDataURL(file);
            }} />
          </label>
        </div>
        <div class="staff-grid">
          <label class="field">Имя<input value={firstName} onInput={(e) => setFirstName(e.currentTarget.value)} autoFocus /></label>
          <label class="field">Фамилия<input value={lastName} onInput={(e) => setLastName(e.currentTarget.value)} /></label>
          <label class="field">Почта<input type="email" value={email} onInput={(e) => setEmail(e.currentTarget.value)} /></label>
          <label class="field">Пароль<input type="password" placeholder="не короче 8 символов" value={password} onInput={(e) => setPassword(e.currentTarget.value)} /></label>
        </div>
        <label class="field">Роль<select value={roleId} onChange={(e) => setRoleId(e.currentTarget.value)}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        {error && <p class="error">{error}</p>}
        <footer class="dialog-actions">
          <button type="button" class="secondary" onClick={onClose}>Отмена</button>
          <button type="submit" disabled={!email.trim() || password.length < 8 || !roleId}>Добавить</button>
        </footer>
      </form>
    </div>
  );
}

function Roles({ onError }: { onError: (s: string) => void }) {
  const { me, can } = useAccess();
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [name, setName] = useState("");
  const load = (): void => {
    void api<{ roles: RoleRow[] }>("/v1/accounts/roles").then((r) => setRoles(r.roles)).catch((e) => onError(message(e)));
    void api<{ users: UserRow[] }>("/v1/accounts/users").then((r) => setUsers(r.users)).catch(() => undefined);
  };
  useEffect(load, []);
  const create = (e: Event): void => {
    e.preventDefault();
    onError("");
    void api("/v1/accounts/roles", { body: { name } }).then(() => { setName(""); load(); }).catch((err) => onError(message(err)));
  };
  const remove = (r: RoleRow): void => {
    if (!confirm(`Удалить роль «${r.name}»?`)) return;
    onError("");
    void api(`/v1/accounts/roles/${r.id}`, { method: "DELETE" }).then(load).catch((err) => onError(message(err)));
  };
  return (
    <div>
      {can("nav:staff", "add") && (
        <form class="staff-toolbar" onSubmit={create}>
          <input placeholder="Название новой роли" value={name} onInput={(e) => setName(e.currentTarget.value)} />
          <button type="submit" disabled={!name.trim()}>Создать роль</button>
        </form>
      )}
      <table class="staff-table">
        <thead><tr><th>Роль</th><th class="center">Сотрудников</th><th /></tr></thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r.id}>
              <td><b>{r.name}</b>{r.system && <div class="muted small">Полные права, менять нельзя</div>}</td>
              <td class="center">{users.filter((u) => u.roleId === r.id).length}</td>
              <td class="staff-actions">
                {!r.system && can("nav:staff", "delete") && r.id !== me?.user?.roleId && <button type="button" class="danger sm" onClick={() => remove(r)}>Удалить</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Rights({ onError }: { onError: (s: string) => void }) {
  const { me, can } = useAccess();
  const isSuper = Boolean(me?.superadmin);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [nav, setNav] = useState<{ id: string; title: string }[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [roleId, setRoleId] = useState("");
  const [grants, setGrants] = useState<Record<string, Grant>>({});
  useEffect(() => {
    void api<{ roles: RoleRow[]; nav: { id: string; title: string }[] }>("/v1/accounts/roles").then((r) => {
      setRoles(r.roles);
      setNav(r.nav);
      setRoleId((cur) => cur || r.roles.find((x) => !x.system)?.id || r.roles[0]?.id || "");
    }).catch((e) => onError(message(e)));
    void api<{ projects: ProjectRow[] }>("/v1/roster/projects").then((r) => setProjects(r.projects)).catch(() => setProjects([]));
  }, []);
  useEffect(() => {
    if (!roleId) return;
    void api<{ grants: Grant[] }>(`/v1/accounts/roles/${roleId}/grants`).then((r) => {
      const map: Record<string, Grant> = {};
      for (const g of r.grants) map[g.resource] = g;
      setGrants(map);
    }).catch((e) => onError(message(e)));
  }, [roleId]);
  const role = roles.find((r) => r.id === roleId);
  const ownRole = !isSuper && roleId === me?.user?.roleId;
  const readOnly = Boolean(role?.system) || ownRole || !can("nav:staff", "edit");
  const cell = (resource: string): Grant => grants[resource] ?? { resource, view: false, add: false, edit: false, delete: false };
  /** A non-superadmin may hand out only what their own role has. Project boxes are not in /v1/auth/me, so the server checks those. */
  const mayGive = (resource: string, action: (typeof ACTIONS)[number]): boolean =>
    isSuper || resource.startsWith("project:") || can(resource, action);
  const setBit = (resource: string, action: (typeof ACTIONS)[number] | "all", on: boolean): void => {
    const cur = cell(resource);
    const next = action === "all"
      ? { ...cur, view: on && mayGive(resource, "view"), add: on && mayGive(resource, "add"), edit: on && mayGive(resource, "edit"), delete: on && mayGive(resource, "delete") }
      : { ...cur, [action]: on };
    setGrants({ ...grants, [resource]: next });
    onError("");
    void api(`/v1/accounts/roles/${roleId}/grants`, { method: "PUT", body: { grants: [next] } }).catch((e) => {
      setGrants((g) => ({ ...g, [resource]: cur }));
      onError(message(e));
    });
  };
  const table = (title: string, rows: { id: string; title: string }[], empty: string) => (
    <table class="staff-table rights-table">
      <thead>
        <tr>
          <th>{title}</th>
          {ACTIONS.map((a) => <th key={a} class="center">{ACTION_LABEL[a]}</th>)}
          <th class="center">Все</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={6} class="muted small">{empty}</td></tr>}
        {rows.map((row) => {
          const g = cell(row.id);
          const all = role?.system || (g.view && g.add && g.edit && g.delete);
          return (
            <tr key={row.id}>
              <td>{row.title}</td>
              {ACTIONS.map((a) => (
                <td key={a} class="center">
                  <input type="checkbox" disabled={readOnly || (!g[a] && !mayGive(row.id, a))} checked={role?.system ? true : g[a]} onChange={(e) => setBit(row.id, a, e.currentTarget.checked)} />
                </td>
              ))}
              <td class="center"><input type="checkbox" disabled={readOnly} checked={all} onChange={(e) => setBit(row.id, "all", e.currentTarget.checked)} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
  return (
    <div class="rights">
      <aside class="rights-roles">
        <div class="menu-label">Роли</div>
        {roles.map((r) => (
          <button key={r.id} type="button" class={r.id === roleId ? "on" : ""} onClick={() => setRoleId(r.id)}>{r.name}</button>
        ))}
      </aside>
      <div class="rights-body">
        {role?.system && <p class="muted small">У суперадмина все права. Их нельзя снять.</p>}
        {ownRole && <p class="muted small">Права своей роли меняет другой администратор.</p>}
        {table("Панель", nav, "")}
        {table("Проекты", projects.map((p) => ({ id: `project:${p.id}`, title: p.name })), "Проектов пока нет.")}
      </div>
    </div>
  );
}
