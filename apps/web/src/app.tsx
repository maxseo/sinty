import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { api, ApiError, setUnauthorizedHandler, shortTime, subscribe, token, type Pending, type SessionInfo, type SintyEvent } from "./api.js";
import { Board } from "./board.js";
import { Chat } from "./chat.js";
import { AgentsPage, SettingsPage } from "./pages.js";
import { useSections } from "./supervisor-ui.js";
import { KitPage } from "./kit.js";
import { PluginTab, type PluginTabInfo } from "./plugin-tab.js";
import { go, href, useRoute } from "./route.js";
import { IconBack, IconChevron, IconDots, IconFolder, IconGear, IconMoon, IconPanelLeft, IconPin, IconPlus, IconSun, IconTrash } from "./icons.js";

interface AgentInfo {
  name: string;
  models: { default: string | null };
  plugins: { name: string; disabled: boolean }[];
}

export function App() {
  const [authed, setAuthed] = useState(Boolean(token.get()));
  useEffect(() => setUnauthorizedHandler(() => setAuthed(false)), []);
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <Shell />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    token.set(value.trim());
    try {
      await api("/v1/agent");
      onDone();
    } catch (err) {
      token.clear();
      setError(err instanceof ApiError && err.status === 401 ? "Неверный токен" : String(err));
    }
  };
  return (
    <form class="login" onSubmit={submit}>
      <h1>Sinty</h1>
      <p class="muted">
        Токен API: <code>sinty token</code> или ссылка из <code>sinty web</code>.
      </p>
      <input type="password" autoFocus placeholder="snt_…" value={value} onInput={(e) => setValue(e.currentTarget.value)} />
      <button type="submit" disabled={!value.trim()}>
        Войти
      </button>
      {error && <p class="error">{error}</p>}
    </form>
  );
}

/** Background agent.task children are real sessions but not sidebar chats. */
function isChildSession(s: SessionInfo): boolean {
  return typeof s.metadata?.parentSessionId === "string" && s.metadata.parentSessionId.length > 0;
}

function Shell() {
  const route = useRoute();
  const [agent, setAgent] = useState<AgentInfo>();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [live, setLive] = useState(false);
  const [lastEvent, setLastEvent] = useState<SintyEvent>();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const [s, p] = await Promise.all([api<{ sessions: SessionInfo[] }>("/v1/sessions?limit=200"), api<{ pending: Pending[] }>("/v1/pending")]);
    setSessions(s.sessions);
    setPending(p.pending);
  }, []);

  useEffect(() => {
    void api<AgentInfo>("/v1/agent").then(setAgent);
    void refresh();
    return subscribe(
      () => "/v1/stream",
      (m) => {
        setLastEvent(JSON.parse(m.data) as SintyEvent);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => void refresh(), 250);
      },
      (ok) => {
        setLive(ok);
        if (ok) void refresh();
      },
    );
  }, [refresh]);

  const [projects, setProjects] = useState<{ id: string; name: string; slug: string }[]>([]);
  const [leftOpen, setLeftOpen] = useState(localStorage.getItem("sinty.left") !== "0");
  const [pins, setPins] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("sinty.pins") ?? "[]") as string[]; } catch { return []; }
  });
  const [openProjects, setOpenProjects] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("sinty.openProjects");
      return saved ? JSON.parse(saved) as string[] : ["__all"];
    } catch { return ["__all"]; }
  });
  const [menu, setMenu] = useState<string | null>(null);
  const [chatProject, setChatProject] = useState<string | null>(null);
  const [projectDraft, setProjectDraft] = useState<string | null>(null);
  const [rename, setRename] = useState<{ id: string; title: string } | null>(null);
  const [agentChoices, setAgentChoices] = useState<{ id: string; name: string }[]>([]);
  const [pickedAgents, setPickedAgents] = useState<string[]>([]);
  const [projectId, setProjectId] = useState(localStorage.getItem("sinty.project") ?? "");
  const hasKanban = agent?.plugins.some((p) => p.name === "kanban" && !p.disabled) ?? false;
  const [tabs, setTabs] = useState<PluginTabInfo[]>([]);
  useEffect(() => {
    void api<{ plugins: { name: string; tabs?: { id: string; title: string; src: string; placement?: "sidebar" | "session" }[] }[] }>("/v1/plugins")
      .then((r) => setTabs(r.plugins.flatMap((p) => (p.tabs ?? []).map((t) => ({ plugin: p.name, ...t, placement: t.placement === "session" ? ("session" as const) : ("sidebar" as const) })))))
      .catch(() => setTabs([]));
  }, [agent]);
  const sideTabs = tabs.filter((t) => t.placement === "sidebar");
  const sessionTabs = useMemo(() => tabs.filter((t) => t.placement === "session"), [tabs]);
  const openTab = route.page === "tab" ? sideTabs.find((t) => t.plugin === route.plugin && t.id === route.tab) : undefined;
  const loadProjects = useCallback(async () => {
    const r = await api<{ projects: { id: string; name: string; slug: string }[] }>("/v1/roster/projects");
    setProjects(r.projects);
  }, []);
  useEffect(() => { void loadProjects(); }, [loadProjects, lastEvent]);
  const chooseProject = (id: string): void => {
    setProjectId(id);
    localStorage.setItem("sinty.project", id);
  };
  const newChat = async (): Promise<void> => {
    const s = await api<SessionInfo>("/v1/sessions", { body: { title: "Новый чат" } });
    await refresh();
    go({ page: "chat", sessionId: s.id });
  };
  const addProject = async (): Promise<void> => {
    const name = projectDraft?.trim();
    if (!name) return;
    setProjectDraft(null);
    const created = await api<{ id: string }>("/v1/roster/projects", { body: { name } });
    await loadProjects();
    setOpenProjects((cur) => {
      const next = cur.includes("__all") ? cur : [...cur, "__all"];
      const withProject = next.includes(created.id) ? next : [...next, created.id];
      localStorage.setItem("sinty.openProjects", JSON.stringify(withProject));
      return withProject;
    });
  };
  const openProjectChat = (id: string): void => {
    setChatProject(id);
    setPickedAgents([]);
    void api<{ agents: { id: string; name: string }[] }>("/v1/roster/agents").then((d) => setAgentChoices(d.agents)).catch(() => setAgentChoices([]));
  };
  const createProjectChat = async (): Promise<void> => {
    if (!chatProject || pickedAgents.length === 0) return;
    const s = await api<SessionInfo>("/v1/sessions", { body: { title: "Новый чат", projectId: chatProject, metadata: { agentIds: pickedAgents } } });
    setChatProject(null);
    await refresh();
    go({ page: "chat", sessionId: s.id });
  };
  const [theme, setTheme] = useState(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const toggleTheme = (): void => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("sinty.theme", next);
    setTheme(next);
  };

  const toggleLeft = (): void => {
    const next = !leftOpen;
    setLeftOpen(next);
    localStorage.setItem("sinty.left", next ? "1" : "0");
  };
  const togglePin = (id: string): void => {
    const next = pins.includes(id) ? pins.filter((x) => x !== id) : [id, ...pins];
    setPins(next);
    localStorage.setItem("sinty.pins", JSON.stringify(next));
  };
  const toggleProjectOpen = (id: string): void => {
    const next = openProjects.includes(id) ? openProjects.filter((x) => x !== id) : [...openProjects, id];
    setOpenProjects(next);
    localStorage.setItem("sinty.openProjects", JSON.stringify(next));
  };
  const patchChat = async (id: string, body: { title?: string; projectId?: string | null }): Promise<void> => {
    await api(`/v1/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body });
    await refresh();
  };
  const settingsOn = route.page === "settings";
  const sections = useSections([agent]);
  const agentsOn = route.page === "agents";
  const chats = sessions.filter((s) => !isChildSession(s));
  const pinned = pins.map((id) => chats.find((s) => s.id === id)).filter((s): s is SessionInfo => Boolean(s));
  const loose = chats.filter((s) => !s.projectId);

  return (
    <div class={`shell ${leftOpen ? "" : "left-closed"}`}>
      <aside class="side">
        {leftOpen ? (
          <>
            <div class="brand">
              <Logo />
              <span class="word"><b>SYNTET</b><span class="tag">harness</span></span>
              <button class="icon" title="Скрыть левую панель" onClick={toggleLeft}><IconPanelLeft /></button>
            </div>
            <div class="side-stage">
              <div class={`side-track ${settingsOn || agentsOn ? "settings" : ""}`}>
                <div class="side-pane">
                  <nav>
                    <a class={route.page === "agents" ? "on" : ""} href={href({ page: "agents" })}>Агенты</a>
                    {hasKanban && <a class={route.page === "board" ? "on" : ""} href={href({ page: "board" })}>Канбан</a>}
                    <a class={route.page === "kit" ? "on" : ""} href={href({ page: "kit" })}>Набор</a>
                    {sideTabs.map((t) => (
                      <a key={`${t.plugin}/${t.id}`} class={route.page === "tab" && route.plugin === t.plugin && route.tab === t.id ? "on" : ""} href={href({ page: "tab", plugin: t.plugin, tab: t.id })} title={`Вкладка плагина ${t.plugin}`}>{t.title}</a>
                    ))}
                  </nav>
                  {pending.length > 0 && (
                    <div class="side-pending">
                      <div class="menu-label">Ждут ответа <span class="badge">{pending.length}</span></div>
                      {pending.map((p) => {
                        const s = sessions.find((x) => x.id === p.sessionId);
                        const parentId =
                          p.parentSessionId ||
                          (typeof s?.metadata?.parentSessionId === "string" ? s.metadata.parentSessionId : undefined);
                        const openId = parentId || p.sessionId;
                        const parent = parentId ? sessions.find((x) => x.id === parentId) : undefined;
                        const label = parent?.title || s?.title || p.title || p.sessionId;
                        const why = p.reason === "approval" ? "одобрение" : p.reason === "ask_human" ? "вопрос" : p.reason === "budget" ? "бюджет" : "супервизор";
                        const childNote = parentId ? "фон" : why;
                        return (
                          <div key={p.turnId} class="pending-row">
                            <a
                              class={route.page === "chat" && route.sessionId === openId ? "on" : ""}
                              href={href({ page: "chat", sessionId: openId })}
                              title={p.detail ?? why}
                            >
                              {label} <span class="small muted">· {childNote}</span>
                            </a>
                            <button
                              type="button"
                              class="icon"
                              title="Снять с ожидания. Этот ход прервётся, новый ответ модели не запустится."
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                void api(`/v1/sessions/${encodeURIComponent(p.sessionId)}/interrupt`, { method: "POST" }).then(() => refresh());
                              }}
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div class="proj-head">
                    <button class="nav-item" onClick={() => toggleProjectOpen("__all")}><IconChevron /> Проекты</button>
                    <button class="icon" title="Новый проект" onClick={() => setProjectDraft("")}><IconPlus /></button>
                  </div>
                  {openProjects.includes("__all") && (
                    <div class="projects">
                      {projects.map((p) => (
                        <div key={p.id}>
                          <div class="proj-line">
                            <button class="nav-item" onClick={() => { toggleProjectOpen(p.id); chooseProject(p.id); }}><IconFolder /> <span class="title">{p.name}</span></button>
                            <button class="icon" title="Новый чат в проекте" onClick={() => openProjectChat(p.id)}><IconPlus /></button>
                          </div>
                          {openProjects.includes(p.id) && chats.filter((s) => s.projectId === p.id).map((s) => (
                            <ChatRow key={s.id} s={s} on={route.page === "chat" && route.sessionId === s.id} pinned={pins.includes(s.id)} menu={menu === s.id} projects={projects} onPin={() => togglePin(s.id)} onMenu={() => setMenu(menu === s.id ? null : s.id)} onPatch={(body) => void patchChat(s.id, body)} onRename={() => { setRename({ id: s.id, title: s.title ?? "" }); setMenu(null); }} onDelete={() => void api(`/v1/sessions/${s.id}`, { method: "DELETE" }).then(() => { if (route.page === "chat" && route.sessionId === s.id) go({ page: "chat" }); return refresh(); })} onCloseMenu={() => setMenu(null)} />
                          ))}
                        </div>
                      ))}
                      <button class="nav-item" onClick={() => toggleProjectOpen("__loose")}><IconFolder /> Вне проекта</button>
                      {openProjects.includes("__loose") && loose.map((s) => (
                        <ChatRow key={s.id} s={s} on={route.page === "chat" && route.sessionId === s.id} pinned={pins.includes(s.id)} menu={menu === s.id} projects={projects} onPin={() => togglePin(s.id)} onMenu={() => setMenu(menu === s.id ? null : s.id)} onPatch={(body) => void patchChat(s.id, body)} onRename={() => { setRename({ id: s.id, title: s.title ?? "" }); setMenu(null); }} onDelete={() => void api(`/v1/sessions/${s.id}`, { method: "DELETE" }).then(() => { if (route.page === "chat" && route.sessionId === s.id) go({ page: "chat" }); return refresh(); })} onCloseMenu={() => setMenu(null)} />
                      ))}
                    </div>
                  )}
                </div>
                <div class="side-pane">
                  <button class="nav-item" onClick={() => go({ page: "chat" })}><IconBack /> Назад</button>
                  {agentsOn ? <AgentNav current={route.page === "agents" ? route.agentId : undefined} /> : (
                    <nav>
                      <a class={settingsOn && route.section === "general" ? "on" : ""} href={href({ page: "settings", section: "general" })}>Основные</a>
                      <a class={settingsOn && route.section === "models" ? "on" : ""} href={href({ page: "settings", section: "models" })}>Модели</a>
                      <a class={settingsOn && route.section === "plugins" ? "on" : ""} href={href({ page: "settings", section: "plugins" })}>Плагины</a>
                      {sections.map((x) => (
                        <a key={x.id} class={settingsOn && route.section === x.id ? "on" : ""} href={href({ page: "settings", section: x.id })} title={x.owner === "plugin" ? `Настройки плагина ${x.plugin}` : undefined}>{x.title}</a>
                      ))}
                    </nav>
                  )}
                </div>
              </div>
            </div>
            <footer class="side-foot">
              <button class="icon" title="Тема" onClick={toggleTheme}>{theme === "dark" ? <IconSun /> : <IconMoon />}</button>
              <button onClick={() => { token.clear(); location.reload(); }}>Выйти</button>
              <button class="icon" title="Настройки" onClick={() => go({ page: "settings", section: "general" })}><IconGear /></button>
            </footer>
          </>
        ) : (
          <div class="peek">
            <button class="icon" title="Открыть левую панель" onClick={toggleLeft}><IconPanelLeft /></button>
            <div class="peek-menu">
              <div class="menu-label">Закреплённые</div>
              {pinned.length === 0 && <div class="muted small">Нет закреплённых чатов</div>}
              {pinned.map((s) => (
                <a key={s.id} href={href({ page: "chat", sessionId: s.id })}>{s.title || s.id}</a>
              ))}
            </div>
          </div>
        )}
      </aside>
      <main class="main">
        {route.page === "chat" && (route.sessionId ? <Chat key={route.sessionId} sessionId={route.sessionId} onChange={refresh} tabs={sessionTabs} /> : <Empty onNew={newChat} />)}
        {route.page === "board" && <Board />}
        {route.page === "agents" && <AgentsPage agentId={route.agentId} />}
        {route.page === "settings" && <SettingsPage section={route.section} onSaved={() => void api<AgentInfo>("/v1/agent").then(setAgent)} />}
        {route.page === "kit" && <KitPage />}
        {route.page === "tab" && (openTab ? <PluginTab key={`${openTab.plugin}/${openTab.id}`} tab={openTab} /> : <div class="empty"><p>Вкладка плагина {route.plugin} не найдена: плагин выключен или не запущен.</p></div>)}
      </main>
      <aside class="dock" />
      {projectDraft !== null && (
        <div class="overlay" onClick={() => setProjectDraft(null)}>
          <form class="dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void addProject(); }}>
            <header class="dialog-head"><h3>Новый проект</h3></header>
            <label class="field">Название<input value={projectDraft} onInput={(e) => setProjectDraft(e.currentTarget.value)} autoFocus /></label>
            <footer class="dialog-actions">
              <button type="button" class="secondary" onClick={() => setProjectDraft(null)}>Отмена</button>
              <button type="submit" disabled={!projectDraft.trim()}>Создать</button>
            </footer>
          </form>
        </div>
      )}
      {rename && (
        <div class="overlay" onClick={() => setRename(null)}>
          <form class="dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (rename.title.trim()) void patchChat(rename.id, { title: rename.title.trim() }); setRename(null); }}>
            <header class="dialog-head"><h3>Название чата</h3></header>
            <label class="field">Название<input value={rename.title} onInput={(e) => setRename({ ...rename, title: e.currentTarget.value })} autoFocus /></label>
            <footer class="dialog-actions">
              <button type="button" class="secondary" onClick={() => setRename(null)}>Отмена</button>
              <button type="submit" disabled={!rename.title.trim()}>Сохранить</button>
            </footer>
          </form>
        </div>
      )}
      {chatProject && (
        <div class="overlay" onClick={() => setChatProject(null)}>
          <div class="dialog" onClick={(e) => e.stopPropagation()}>
            <header class="dialog-head"><h3>Участники чата</h3></header>
            <p class="small muted">Отметьте агентов, которые будут в этом чате.</p>
            {agentChoices.length === 0 && <p class="muted small">Сначала создайте агента.</p>}
            {agentChoices.map((a) => (
              <label key={a.id} class="check">
                <input type="checkbox" checked={pickedAgents.includes(a.id)} onChange={() => setPickedAgents(pickedAgents.includes(a.id) ? pickedAgents.filter((id) => id !== a.id) : [...pickedAgents, a.id])} />
                <span>{a.name}</span>
              </label>
            ))}
            <footer class="dialog-actions">
              <button type="button" class="secondary" onClick={() => setChatProject(null)}>Отмена</button>
              <button type="button" disabled={pickedAgents.length === 0} onClick={() => void createProjectChat()}>Создать чат</button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentNav({ current }: { current?: string }) {
  const [rows, setRows] = useState<{ id: string; name: string; specialization: string; summary: string; avatar: string }[]>([]);
  const [tip, setTip] = useState<{ id: string; x: number; y: number } | null>(null);
  const load = (): void => {
    api<{ agents: { id: string; name: string; specialization: string; summary: string; avatar: string }[] }>("/v1/roster/agents").then((d) => setRows(d.agents)).catch(() => setRows([]));
  };
  useEffect(() => {
    load();
    addEventListener("sinty-agents", load);
    return () => removeEventListener("sinty-agents", load);
  }, []);
  const shown = tip ? rows.find((a) => a.id === tip.id) : undefined;
  return (
    <nav>
      {rows.map((a) => (
        <div key={a.id} class="agent-row">
          <a class={current === a.id ? "on" : ""} href={href({ page: "agents", agentId: a.id })}>
            <span class="agent-ava" onMouseEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); setTip({ id: a.id, x: r.right, y: r.bottom }); }} onMouseLeave={() => setTip(null)}>
              {a.avatar ? <img src={a.avatar} alt="" /> : (a.name.slice(0, 1) || "?")}
            </span>
            <span class="agent-name">
              <span class="title">{a.name}</span>
              {a.specialization && <span class="agent-spec">{a.specialization}</span>}
            </span>
          </a>
          <button type="button" class="icon" title="Удалить" onClick={() => void api(`/v1/roster/agents/${a.id}`, { method: "DELETE" }).then(() => { dispatchEvent(new Event("sinty-agents")); if (current === a.id) go({ page: "agents" }); })}><IconTrash /></button>
        </div>
      ))}
      {shown?.summary && tip && createPortal(
        <div class="agent-tip" style={{ left: `${tip.x}px`, top: `${tip.y}px` }}>{shown.summary}</div>,
        document.body,
      )}
      <button class="nav-item" onClick={() => go({ page: "agents", agentId: "new" })}><IconPlus /> Новый агент</button>
    </nav>
  );
}

function ChatRow({ s, on, pinned, menu, projects, onPin, onMenu, onPatch, onRename, onDelete, onCloseMenu }: {
  s: SessionInfo;
  on: boolean;
  pinned: boolean;
  menu: boolean;
  projects: { id: string; name: string; slug: string }[];
  onPin: () => void;
  onMenu: () => void;
  onPatch: (body: { title?: string; projectId?: string | null }) => void;
  onRename: () => void;
  onDelete: () => void;
  onCloseMenu: () => void;
}) {
  const project = projects.find((p) => p.id === s.projectId);
  const path = project ? `projects/${project.slug}` : "workspace";
  return (
    <div class="chat-row">
      <a class={on ? "on" : ""} href={href({ page: "chat", sessionId: s.id })}>
        <span class={`dot ${s.activeTurn?.status ?? "idle"}`} />
        <span class="title">{s.title || s.id}</span>
      </a>
      <button class={`icon ${pinned ? "on" : ""}`} title="Закрепить" onClick={onPin}><IconPin /></button>
      <button class="icon" title="Ещё" onClick={onMenu}><IconDots /></button>
      {menu && (
        <div class="row-menu">
          <button class="menu-item" onClick={onRename}>Переименовать</button>
          <div class="menu-label">В проект</div>
          {projects.map((p) => (
            <button key={p.id} class="menu-item" onClick={() => { onPatch({ projectId: p.id }); onCloseMenu(); }}>{p.name}</button>
          ))}
          {s.projectId && <button class="menu-item" onClick={() => { onPatch({ projectId: null }); onCloseMenu(); }}>Перенести вне проекта</button>}
          <button class="menu-item" onClick={() => { onDelete(); onCloseMenu(); }}>Удалить чат</button>
          <button class="menu-item" onClick={() => { void navigator.clipboard.writeText(path); onCloseMenu(); }}>Скопировать путь</button>
        </div>
      )}
    </div>
  );
}

function Logo() {
  return (
    <svg class="logo" xmlns="http://www.w3.org/2000/svg" width="22" height="24" viewBox="0 0 304 333" aria-hidden="true">
      <path fill="currentColor" fill-rule="evenodd" d="M 184 30.577 C 172.049 32.488, 150.913 39.479, 138.789 45.533 C 125.896 51.971, 111.703 61.599, 102.668 70.037 C 98.469 73.958, 92.788 80.524, 90.043 84.627 C 87.299 88.731, 84.141 95.041, 83.027 98.649 C 81.912 102.258, 81 107.629, 81 110.584 C 81 117.569, 84.239 127.286, 88.542 133.211 C 93.329 139.803, 104.922 149.080, 114.984 154.369 C 123.913 159.063, 138.972 165.361, 139.649 164.685 C 139.866 164.467, 137.039 162.537, 133.365 160.395 C 129.692 158.253, 124.139 153.996, 121.025 150.936 C 117.912 147.875, 114.157 142.950, 112.682 139.989 C 110.650 135.912, 110 133.122, 110 128.482 C 110 125.113, 110.682 120.364, 111.515 117.928 C 112.349 115.493, 115.268 110.519, 118.002 106.875 C 126.060 96.134, 141.041 84.911, 158.648 76.423 C 179.093 66.567, 201.501 61.419, 213.480 63.824 C 216.570 64.445, 220.648 65.688, 222.543 66.587 C 227.826 69.094, 231.663 74.133, 233.067 80.408 C 234.006 84.604, 234.041 87.539, 233.210 92.549 C 231.972 100.023, 227.617 110.010, 222.477 117.165 C 220.567 119.824, 219.408 122, 219.903 122 C 220.397 122, 223.574 119.916, 226.963 117.368 C 239.140 108.215, 250.012 92.265, 253.023 79.139 C 253.699 76.190, 254.034 70.722, 253.767 66.988 C 253.429 62.269, 252.362 58.262, 250.268 53.849 C 245.167 43.104, 237.257 36.761, 223.500 32.386 C 217.540 30.490, 212.696 29.742, 204.500 29.450 C 197.601 29.205, 189.958 29.625, 184 30.577 M 89.266 64.988 C 73.891 74.534, 60.440 86.987, 52.590 98.943 C 49.902 103.037, 46.670 108.927, 45.409 112.032 C 42.216 119.889, 40.649 129.895, 41.445 137.332 C 42.354 145.816, 46.020 155.857, 51.001 163.502 C 56.768 172.353, 70.145 184.855, 82.273 192.728 C 94.446 200.631, 111.320 209.518, 130.500 218.129 C 142.133 223.351, 145.628 224.481, 151.171 224.815 C 156.784 225.153, 158.504 224.844, 162.019 222.869 C 166.417 220.397, 170.326 214.795, 171.463 209.334 C 171.826 207.592, 171.616 204.289, 170.998 201.993 C 169.344 195.849, 163.437 190.033, 155.344 186.579 C 133.666 177.329, 118.429 170.163, 110.333 165.412 C 97.691 157.993, 86.330 149.222, 81.113 142.855 C 78.701 139.910, 75.172 134.256, 73.272 130.291 C 70.560 124.632, 69.702 121.405, 69.284 115.291 C 68.980 110.842, 69.268 105.015, 69.956 101.706 C 70.618 98.519, 72.993 92.249, 75.234 87.773 C 78.360 81.527, 81.424 77.466, 88.404 70.316 C 93.407 65.191, 97.050 61.024, 96.500 61.057 C 95.950 61.090, 92.695 62.859, 89.266 64.988 M 146.500 106.662 C 141.859 109.108, 138.906 112.131, 136.890 116.500 C 135.875 118.700, 135.034 122.045, 135.022 123.934 C 134.992 128.568, 138.504 135.520, 142.361 138.462 C 144.097 139.786, 150.689 143.094, 157.009 145.813 C 190.551 160.243, 208.162 170.352, 220.788 182.424 C 227.503 188.845, 229.867 191.945, 233.246 198.763 C 237.049 206.439, 237.451 207.992, 237.821 216.445 C 238.266 226.635, 236.810 233.474, 232.282 242.457 C 228.916 249.134, 221.174 258.794, 214.223 264.989 C 211.131 267.745, 209.069 270, 209.641 270 C 211.612 270, 227.177 260.082, 234.116 254.405 C 251.494 240.188, 262.144 223.540, 265.012 206.112 C 267.251 192.503, 264.117 178.827, 255.966 166.641 C 247.097 153.381, 232.359 141.132, 210.182 128.588 C 200.740 123.248, 173.409 110.356, 164.712 107.140 C 157.923 104.630, 150.714 104.440, 146.500 106.662 M 173.542 169.898 C 182.935 175.678, 192.233 185.035, 195.227 191.721 C 198.167 198.285, 198.136 207.785, 195.152 214.449 C 191.799 221.939, 185.528 229.432, 176.574 236.647 C 161.646 248.676, 142.001 258.858, 123.475 264.169 C 117.030 266.016, 113.002 266.459, 102.476 266.477 C 90.449 266.498, 89.073 266.305, 84.486 263.945 C 81.472 262.396, 78.334 259.706, 76.509 257.107 C 73.679 253.078, 73.504 252.279, 73.560 243.662 C 73.609 236.105, 74.083 233.396, 76.260 228.201 C 77.711 224.737, 80.731 219.159, 82.971 215.806 C 85.210 212.453, 86.826 209.493, 86.562 209.229 C 85.586 208.253, 73.313 218.856, 67.651 225.567 C 57.198 237.958, 52.384 250.610, 53.225 263.480 C 53.808 272.396, 57.682 280.847, 64.006 287 C 66.550 289.475, 71.077 292.732, 74.066 294.239 C 77.055 295.745, 83.320 297.941, 87.988 299.120 C 95.312 300.969, 98.329 301.190, 109.988 300.732 C 121.097 300.296, 125.937 299.568, 137.202 296.642 C 151.514 292.924, 167.439 286.383, 179.737 279.171 C 190.715 272.733, 202.308 263.616, 209.234 255.975 C 216.215 248.273, 222.419 238.602, 224.269 232.538 C 224.946 230.317, 225.500 224.225, 225.500 219 C 225.500 210.623, 225.169 208.827, 222.705 203.808 C 221.167 200.677, 217.928 195.912, 215.507 193.219 C 210.528 187.681, 199.491 179.759, 190.355 175.167 C 183.708 171.825, 167.592 165, 166.348 165 C 165.928 165, 169.165 167.204, 173.542 169.898" />
    </svg>
  );
}

function Empty({ onNew }: { onNew: () => Promise<void> }) {
  return (
    <div class="empty">
      <p>Выберите чат слева или начните новый.</p>
      <button onClick={() => void onNew()}>+ Новый чат</button>
    </div>
  );
}
