import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, subscribe, token } from "./api.js";
import { IconTrash } from "./icons.js";
import { href } from "./route.js";

interface Label { name: string; color: string }
interface Card {
  id: string;
  title: string;
  description: string;
  column: string;
  assigneeId: string | null;
  reviewerId: string | null;
  projectId?: string;
  priority: "high" | "med" | "low";
  label: Label | null;
  dependsOn: string[];
  goals?: { id: string; text: string; done: boolean }[];
  reviewMode?: "human" | "rework" | "accept";
  notify: "chat" | "none";
  result: string;
  activity: { text: string; at: string }[];
  attachments: { id: string; name: string; bytes: number }[];
  sessionId: string | null;
  state: string | null;
  comments: { by: string; text: string; at: string }[];
}
interface BoardData { columns: { id: string; title: string }[]; cards: Card[] }
interface Agent { id: string; name: string; specialization: string; avatar: string }
interface Project { id: string; name: string; leadId: string; agentIds: string[] }

const PRIO: Record<string, string> = { high: "Высокий", med: "Средний", low: "Низкий" };
const HINT: Record<string, string> = {
  backlog: "Тимлид оформляет и нарезает",
  todo: "Ждут исполнителя",
  doing: "Исполнитель делает карточку",
  review: "Проверяющий принимает результат",
  done: "Закрыто",
};
const COLORS = ["#74ff2a", "#38bdf8", "#f59e0b", "#f43f5e", "#a78bfa", "#e4e4e7"];

export function Board() {
  const [board, setBoard] = useState<BoardData>();
  const [open, setOpen] = useState<string>();
  const [dragging, setDragging] = useState<string>();
  const [error, setError] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [search, setSearch] = useState("");
  const [filterAssignee, setFilterAssignee] = useState("");
  const [filterLabel, setFilterLabel] = useState("");
  const [filterPriority, setFilterPriority] = useState("");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [trashOn, setTrashOn] = useState(false);
  const [ask, setAsk] = useState<{ text: string; run: () => void } | null>(null);
  const dragId = useRef("");

  useEffect(() => {
    void api<{ agents: Agent[] }>("/v1/roster/agents").then((r) => setAgents(r.agents)).catch(() => setAgents([]));
    void api<{ projects: Project[] }>("/v1/roster/projects").then((r) => setProjects(r.projects)).catch(() => setProjects([]));
  }, []);
  useEffect(() => subscribe(() => "/p/kanban/stream", (m) => { if (m.event === "board") setBoard(JSON.parse(m.data) as BoardData); }), []);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setError("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const patch = (id: string, body: Record<string, unknown>): Promise<void> => run(() => api(`/p/kanban/cards/${id}`, { method: "PATCH", body }));
  const labels = useMemo(() => [...new Set((board?.cards ?? []).map((c) => c.label?.name).filter((n): n is string => !!n))], [board]);
  const visible = (c: Card): boolean => {
    if (search && !`${c.title} ${c.description}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterAssignee === "none" && c.assigneeId) return false;
    if (filterAssignee && filterAssignee !== "none" && c.assigneeId !== filterAssignee) return false;
    if (filterLabel && c.label?.name !== filterLabel) return false;
    if (filterPriority && c.priority !== filterPriority) return false;
    return true;
  };
  const nameOf = (id: string | null): string => agents.find((a) => a.id === id)?.name ?? (id ? id : "не назначен");

  const create = async (projectId: string): Promise<void> => {
    const lead = projects.find((p) => p.id === projectId)?.leadId;
    const card = await api<Card>("/p/kanban/cards", { body: { title: "Новая задача", column: "backlog", projectId: projectId || undefined, assigneeId: lead || null, priority: "med", notify: "chat" } });
    setCreating(false);
    setOpen(card.id);
  };

  if (!board) return <div class="empty">Загрузка доски…</div>;
  const card = board.cards.find((c) => c.id === open);

  return (
    <section class="kb">
      <header class="kb-top">
        <div>
          <h2>Канбан</h2>
          <p>{board.cards.length} задач</p>
        </div>
        <button type="button" class="kb-add" onClick={() => (projects.length > 1 ? setCreating(true) : void run(() => create(projects[0]?.id ?? "")))}>+ Задача</button>
      </header>
      <div class="kb-bar">
      <div class="kb-filters">
        <label class="kb-search"><span>Поиск</span><input value={search} placeholder="Фильтр карточек…" onInput={(e) => setSearch(e.currentTarget.value)} /></label>
        <label class="kb-narrow"><span>Исполнитель</span>
          <select value={filterAssignee} onChange={(e) => setFilterAssignee(e.currentTarget.value)}>
            <option value="">Все</option>
            <option value="none">Не назначен</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label class="kb-narrow"><span>Метка</span>
          <select value={filterLabel} onChange={(e) => setFilterLabel(e.currentTarget.value)}>
            <option value="">Все метки</option>
            {labels.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label class="kb-narrow"><span>Приоритет</span>
          <select value={filterPriority} onChange={(e) => setFilterPriority(e.currentTarget.value)}>
            <option value="">Все</option>
            <option value="high">Высокий</option>
            <option value="med">Средний</option>
            <option value="low">Низкий</option>
          </select>
        </label>
        </div>
      <div class="kb-filter-actions">
        {selected.length > 0 && <span class="kb-picked">{selected.length} выбрано</span>}
        {selected.length > 0 && <button type="button" class="kb-danger" onClick={() => {
          const ids = selected;
          setAsk({ text: `Удалить карточки: ${ids.length}?`, run: () => { setSelected([]); void run(async () => { for (const id of ids) await api(`/p/kanban/cards/${id}`, { method: "DELETE" }); }); } });
        }}>Удалить</button>}
        {selected.length > 0 && <button type="button" class="kb-ghost" onClick={() => setSelected([])}>Снять выбор</button>}
        <button type="button" class="kb-ghost" onClick={() => { setSearch(""); setFilterAssignee(""); setFilterLabel(""); setFilterPriority(""); }}>Сбросить фильтры</button>
      </div>
      </div>
      {error && <p class="error">{error}</p>}
      <div class="kb-area">
      <div class="kb-board">
        {board.columns.map((col) => {
          const cards = board.cards.filter((c) => c.column === col.id && visible(c));
          return (
            <section
              key={col.id}
              class="kb-col"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const id = dragId.current; dragId.current = ""; setDragging(undefined); if (id) void patch(id, { column: col.id }); }}
            >
              <header>
                <Check
                  checked={cards.length > 0 && cards.every((c) => selected.includes(c.id))}
                  indeterminate={cards.some((c) => selected.includes(c.id)) && !cards.every((c) => selected.includes(c.id))}
                  onChange={() => {
                    const ids = cards.map((c) => c.id);
                    const all = ids.length > 0 && ids.every((id) => selected.includes(id));
                    setSelected(all ? selected.filter((id) => !ids.includes(id)) : [...new Set([...selected, ...ids])]);
                  }}
                />
                <span class="kb-dot" data-col={col.id} />
                <h3>{col.title}</h3>
                <span class="kb-count">{cards.length}</span>
              </header>
              <p class="kb-hint">{HINT[col.id] ?? ""}</p>
              <div class="kb-list">
                {cards.map((c) => {
                  const agent = agents.find((a) => a.id === c.assigneeId);
                  const waiting = c.dependsOn.filter((id) => board.cards.find((x) => x.id === id)?.column !== "done");
                  return (
                    <article key={c.id} class={`kb-card ${c.state ?? ""} ${selected.includes(c.id) ? "is-on" : ""}`} draggable onDragStart={() => { dragId.current = c.id; setDragging(c.id); }} onDragEnd={() => { setDragging(undefined); setTrashOn(false); }} onClick={() => setOpen(c.id)}>
                      <div class="kb-card-top">
                        <Check checked={selected.includes(c.id)} onClick={(e) => e.stopPropagation()} onChange={() => setSelected(selected.includes(c.id) ? selected.filter((id) => id !== c.id) : [...selected, c.id])} />
                        <span class="kb-id">#{c.id}</span>
                        {waiting.length > 0 && <span class="kb-wait">ждёт #{waiting[0]}</span>}
                        {c.state === "blocked" && <span class="kb-wait">ждёт</span>}
                        <span class="kb-prio" data-prio={c.priority}>{PRIO[c.priority]}</span>
                      </div>
                      <h4>{c.title}</h4>
                      {c.description && <p>{c.description}</p>}
                      {c.label && <span class="kb-tag" style={{ color: c.label.color, borderColor: c.label.color }}>{c.label.name}</span>}
                      <footer>
                        <span class="kb-ava">{agent?.avatar ? <img src={agent.avatar} alt="" /> : (agent?.name ?? "?").slice(0, 1)}</span>
                        <span><b>{agent?.specialization || "исполнитель"}</b>{nameOf(c.assigneeId)}</span>
                      </footer>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <aside
        class={`kb-trash ${dragging ? "is-armed" : ""} ${trashOn ? "is-over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setTrashOn(true); }}
        onDragLeave={() => setTrashOn(false)}
        onDrop={(e) => {
          e.preventDefault();
          setTrashOn(false);
          const id = dragId.current;
          dragId.current = "";
          setDragging(undefined);
          if (id) setAsk({ text: "Удалить карточку?", run: () => void run(() => api(`/p/kanban/cards/${id}`, { method: "DELETE" })) });
        }}
      >
        <span class="kb-trash-ico"><IconTrash /></span>
        <b>Удалить</b>
        <span>Перетащите карточку сюда</span>
      </aside>
      </div>
      {creating && (
        <div class="kb-back" onClick={() => setCreating(false)}>
          <form class="kb-create" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); const id = new FormData(e.currentTarget).get("project"); void run(() => create(String(id ?? ""))); }}>
            <h3>Новая задача</h3>
            <label>Проект
              <select name="project">{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            </label>
            <p class="kb-hint">Карточка попадёт в бэклог.</p>
            <button type="submit" class="kb-add">Создать</button>
          </form>
        </div>
      )}
      {card && (
        <Drawer
          card={card}
          cards={board.cards}
          agents={agents}
          projects={projects}
          onOpen={setOpen}
          onClose={() => setOpen(undefined)}
          onPatch={(b) => patch(card.id, b)}
          onDelete={() => setAsk({ text: "Удалить карточку?", run: () => run(async () => { await api(`/p/kanban/cards/${card.id}`, { method: "DELETE" }); setOpen(undefined); }) })}
          onRefresh={() => run(() => api<BoardData>("/p/kanban/board").then(setBoard))}
        />
      )}
    {ask && (
        <div class="kb-modal" onClick={() => setAsk(null)}>
          <div class="kb-modal-card" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Удалить?</h3>
            <p>{ask.text}</p>
            <footer>
              <button type="button" class="kb-ghost" onClick={() => setAsk(null)}>Отмена</button>
              <button type="button" class="kb-danger" onClick={() => { const go = ask.run; setAsk(null); go(); }}>Удалить</button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}

function Check(props: { checked: boolean; indeterminate?: boolean; onChange: () => void; onClick?: (e: Event) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!props.indeterminate && !props.checked;
  }, [props.indeterminate, props.checked]);
  return <input ref={ref} type="checkbox" class="kb-check" checked={props.checked} onClick={props.onClick} onChange={props.onChange} />;
}

function Drawer(props: {
  card: Card;
  cards: Card[];
  agents: Agent[];
  projects: Project[];
  onOpen: (id: string) => void;
  onClose: () => void;
  onPatch: (body: Record<string, unknown>) => Promise<void>;
  onDelete: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { card } = props;
  const project = props.projects.find((p) => p.id === card.projectId);
  const members = props.agents.filter((a) => !project || project.agentIds.includes(a.id));
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [assigneeId, setAssigneeId] = useState(card.assigneeId ?? "");
  const [reviewerId, setReviewerId] = useState(card.reviewerId ?? "");
  const [priority, setPriority] = useState(card.priority);
  const [labelName, setLabelName] = useState(card.label?.name ?? "");
  const [labelColor, setLabelColor] = useState(card.label?.color ?? COLORS[0]!);
  const [notify, setNotify] = useState(card.notify);
  const [dependsOn, setDependsOn] = useState(card.dependsOn);
  const [goals, setGoals] = useState(card.goals ?? []);
  const [reviewMode, setReviewMode] = useState(card.reviewMode ?? "human");
  const [goalText, setGoalText] = useState("");
  const [result, setResult] = useState(card.result ?? "");
  const [comment, setComment] = useState("");
  const [parentPick, setParentPick] = useState("");
  const [childPick, setChildPick] = useState("");

  useEffect(() => {
    setTitle(card.title); setDescription(card.description); setAssigneeId(card.assigneeId ?? ""); setReviewerId(card.reviewerId ?? "");
    setPriority(card.priority); setLabelName(card.label?.name ?? ""); setLabelColor(card.label?.color ?? COLORS[0]!);
    setNotify(card.notify); setDependsOn(card.dependsOn); setGoals(card.goals ?? []); setReviewMode(card.reviewMode ?? "human"); setResult(card.result ?? "");
  }, [card]);

  const save = (): void => {
    void props.onPatch({
      title: title.trim() || card.title,
      description,
      assigneeId: assigneeId || null,
      reviewerId: reviewerId || null,
      priority,
      label: labelName.trim() ? { name: labelName.trim(), color: labelColor } : null,
      notify,
      dependsOn,
      goals,
      reviewMode,
      result,
    });
  };
  const parents = props.cards.filter((c) => dependsOn.includes(c.id));
  const children = props.cards.filter((c) => c.dependsOn.includes(card.id) && c.id !== card.id);
  const candidates = props.cards.filter((c) => c.id !== card.id);
  const when = (at: string): string => at ? at.slice(0, 16).replace("T", " ") : "";

  return (
    <div class="kb-back" onClick={props.onClose}>
      <aside class="kb-drawer" onClick={(e) => e.stopPropagation()}>
        <header class="kb-drawer-head">
          <div class="kb-meta">
            <span class="kb-id">#{card.id}</span>
            <span class="kb-prio" data-prio={priority}>{PRIO[priority]}</span>
            {project && <span class="kb-tag">{project.name}</span>}
            <button type="button" class="kb-x" onClick={props.onClose} aria-label="Закрыть">✕</button>
          </div>
          <textarea class="kb-title" rows={2} value={title} placeholder="Название задачи" onInput={(e) => setTitle(e.currentTarget.value)} />
        </header>
        <div class="kb-body">
          <label class="kb-field"><span>Приоритет</span>
            <select value={priority} onChange={(e) => setPriority(e.currentTarget.value as Card["priority"])}>
              <option value="high">Высокий</option><option value="med">Средний</option><option value="low">Низкий</option>
            </select>
          </label>
          <label class="kb-field"><span>Исполнитель</span>
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.currentTarget.value)}>
              <option value="">— не назначен —</option>
              {members.map((a) => <option key={a.id} value={a.id}>{a.name}{a.specialization ? ` · ${a.specialization}` : ""}</option>)}
            </select>
          </label>
          <label class="kb-field"><span>Проверяющий</span>
            <select value={reviewerId} onChange={(e) => setReviewerId(e.currentTarget.value)}>
              <option value="">— тимлид / человек —</option>
              {members.map((a) => <option key={a.id} value={a.id}>{a.name}{a.specialization ? ` · ${a.specialization}` : ""}</option>)}
            </select>
          </label>
          <label class="kb-field"><span>Приёмка</span>
            <select value={reviewMode} onChange={(e) => setReviewMode(e.currentTarget.value as "human" | "rework" | "accept")}>
              <option value="human">Отчёт человеку</option>
              <option value="rework">Сразу на доработку</option>
              <option value="accept">Можно принять</option>
            </select>
          </label>
          <div class="kb-field"><span>Цели</span>
            {goals.map((g) => (
              <label key={g.id} class="kb-dep">
                <input type="checkbox" checked={g.done} onChange={() => setGoals(goals.map((x) => x.id === g.id ? { ...x, done: !x.done } : x))} />
                {g.text}
              </label>
            ))}
            <div class="kb-row">
              <input value={goalText} placeholder="Контрольная точка" onInput={(e) => setGoalText(e.currentTarget.value)} />
              <button type="button" class="kb-ghost" disabled={!goalText.trim()} onClick={() => { setGoals([...goals, { id: goalText.trim().slice(0, 12), text: goalText.trim(), done: false }]); setGoalText(""); }}>+ цель</button>
            </div>
          </div>
          <label class="kb-field"><span>Описание</span>
            <textarea rows={4} value={description} placeholder="Что сделать и зачем" onInput={(e) => setDescription(e.currentTarget.value)} />
          </label>
          <div class="kb-field"><span>Метка</span>
            <input value={labelName} placeholder="Название метки" onInput={(e) => setLabelName(e.currentTarget.value)} />
            <div class="kb-swatches">{COLORS.map((c) => <button key={c} type="button" class={c === labelColor ? "on" : ""} style={{ background: c }} onClick={() => setLabelColor(c)} />)}</div>
          </div>
          <div class="kb-field"><span>Уведомления</span>
            <div class="kb-chips">
              <button type="button" class={notify === "chat" ? "on" : ""} onClick={() => setNotify("chat")}>Чат</button>
              <button type="button" class={notify === "none" ? "on" : ""} onClick={() => setNotify("none")}>Нет</button>
            </div>
            <p class="kb-hint">«Чат» пишет реплики в общий чат команды. «Нет» оставляет их только на доске.</p>
          </div>
          <div class="kb-field"><span>Зависимости</span>
            <p class="kb-sub">Родители — кого ждёт эта карточка</p>
            {parents.length === 0 && <p class="kb-hint">Нет родителей</p>}
            {parents.map((p) => (
              <button key={p.id} type="button" class="kb-dep" onClick={() => props.onOpen(p.id)}>
                <span>#{p.id}</span> {p.title}
                <i onClick={(e) => { e.stopPropagation(); setDependsOn(dependsOn.filter((id) => id !== p.id)); }}>✕</i>
              </button>
            ))}
            <div class="kb-row">
              <select value={parentPick} onChange={(e) => setParentPick(e.currentTarget.value)}>
                <option value="">— выбрать —</option>
                {candidates.filter((c) => !dependsOn.includes(c.id)).map((c) => <option key={c.id} value={c.id}>#{c.id} · {c.title}</option>)}
              </select>
              <button type="button" class="kb-ghost" disabled={!parentPick} onClick={() => { setDependsOn([...dependsOn, parentPick]); setParentPick(""); }}>+ родитель</button>
            </div>
            <p class="kb-sub">Дети — кто ждёт эту карточку</p>
            {children.length === 0 && <p class="kb-hint">Нет потомков</p>}
            {children.map((c) => (
              <button key={c.id} type="button" class="kb-dep" onClick={() => props.onOpen(c.id)}>
                <span>#{c.id}</span> {c.title}
                <i onClick={(e) => { e.stopPropagation(); void api(`/p/kanban/cards/${c.id}`, { method: "PATCH", body: { dependsOn: c.dependsOn.filter((id) => id !== card.id) } }).then(() => props.onRefresh()); }}>✕</i>
              </button>
            ))}
            <div class="kb-row">
              <select value={childPick} onChange={(e) => setChildPick(e.currentTarget.value)}>
                <option value="">— выбрать —</option>
                {candidates.filter((c) => !c.dependsOn.includes(card.id)).map((c) => <option key={c.id} value={c.id}>#{c.id} · {c.title}</option>)}
              </select>
              <button type="button" class="kb-ghost" disabled={!childPick} onClick={() => {
                const child = props.cards.find((c) => c.id === childPick);
                if (!child) return;
                void api(`/p/kanban/cards/${child.id}`, { method: "PATCH", body: { dependsOn: [...child.dependsOn, card.id] } }).then(() => props.onRefresh());
                setChildPick("");
              }}>+ потомок</button>
            </div>
          </div>
          <div class="kb-field">
            <div class="kb-row">
              <span>Вложения ({card.attachments?.length ?? 0})</span>
              <label class="kb-file-btn">Загрузить файл<input type="file" hidden onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                if (!file) return;
                const body = new FormData();
                body.set("file", file);
                void fetch(`/p/kanban/cards/${card.id}/files`, { method: "POST", headers: { authorization: `Bearer ${token.get()}` }, body }).then(() => props.onRefresh());
              }} /></label>
            </div>
            {(card.attachments ?? []).length === 0 && <p class="kb-hint">Файлов пока нет</p>}
            {(card.attachments ?? []).map((a) => (
              <div key={a.id} class="kb-file">
                <button type="button" class="kb-link" onClick={() => void fetch(`/p/kanban/cards/${card.id}/files/${a.id}`, { headers: { authorization: `Bearer ${token.get()}` } }).then(async (r) => { const b = await r.blob(); const u = URL.createObjectURL(b); const el = document.createElement("a"); el.href = u; el.download = a.name; el.click(); URL.revokeObjectURL(u); })}>{a.name}</button>
                <button type="button" onClick={() => void fetch(`/p/kanban/cards/${card.id}/files/${a.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token.get()}` } }).then(() => props.onRefresh())}>✕</button>
              </div>
            ))}
          </div>
          <label class="kb-field"><span>Результат / артефакт</span>
            <textarea rows={3} value={result} placeholder="Ссылка, MD, путь к файлу…" onInput={(e) => setResult(e.currentTarget.value)} />
          </label>
          <div class="kb-field"><span>Комментарии</span>
            {(card.comments ?? []).length === 0 && <p class="kb-hint">Пока пусто.</p>}
            <ul class="kb-comments">
              {card.comments.map((c, i) => <li key={i}><b>{c.by === "agent" ? "агент" : "человек"}</b> <time>{when(c.at)}</time><p>{c.text}</p></li>)}
            </ul>
            <textarea rows={2} value={comment} placeholder="Добавить комментарий…" onInput={(e) => setComment(e.currentTarget.value)} />
            <button type="button" class="kb-add" disabled={!comment.trim()} onClick={() => void props.onPatch({ comment: comment.trim() }).then(() => setComment(""))}>Комментарий</button>
          </div>
          <div class="kb-field"><span>Активность</span>
            <ul class="kb-log">
              {(card.activity ?? []).slice().reverse().map((a, i) => <li key={i}><i /><div><time>{when(a.at)}</time>{a.text}</div></li>)}
            </ul>
          </div>
          {card.sessionId && <a href={href({ page: "chat", sessionId: card.sessionId })}>Чат карточки</a>}
        </div>
        <footer class="kb-foot">
          <button type="button" class="kb-ghost" onClick={props.onDelete}>Удалить</button>
          <button type="button" class="kb-add" onClick={save}>Сохранить</button>
        </footer>
      </aside>
    </div>
  );
}
