import { useEffect, useState } from "preact/hooks";
import { api, subscribe } from "./api.js";
import { href } from "./route.js";

interface Card {
  id: string;
  title: string;
  description: string;
  column: string;
  assignee: "agent" | "human";
  sessionId: string | null;
  state: string | null;
  runs: number;
  order: number;
  comments: { by: string; text: string; at: string }[];
  createdBy: string;
  projectId?: string;
}

interface BoardData {
  columns: { id: string; title: string }[];
  cards: Card[];
}

const STATE: Record<string, string> = { working: "работает", blocked: "ждёт человека", done: "готово", error: "ошибка", idle: "свободен" };

export function Board() {
  const [board, setBoard] = useState<BoardData>();
  const [open, setOpen] = useState<string>();
  const [dragging, setDragging] = useState<string>();
  const [error, setError] = useState("");
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    void api<{ projects: { id: string; name: string }[] }>("/v1/roster/projects").then((r) => setProjects(r.projects)).catch(() => setProjects([]));
  }, []);

  useEffect(
    () =>
      subscribe(
        () => "/p/kanban/stream",
        (m) => {
          if (m.event === "board") setBoard(JSON.parse(m.data) as BoardData);
        },
      ),
    [],
  );

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const patch = (id: string, body: Record<string, unknown>): Promise<void> => run(() => api(`/p/kanban/cards/${id}`, { method: "PATCH", body }));

  if (!board) return <div class="empty">Загрузка доски…</div>;
  const card = board.cards.find((c) => c.id === open);

  return (
    <section class="board-page">
      <header class="bar">
        <h2>Канбан</h2>
        <span class="muted small">Карточки агента из «К работе» запускаются сами; перетащите в «В работе», чтобы начать сразу.</span>
      </header>
      {error && <p class="error">{error}</p>}
      <div class="board">
        {board.columns.map((col) => (
          <div
            key={col.id}
            class="column"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging) void patch(dragging, { column: col.id });
              setDragging(undefined);
            }}
          >
            <h3>
              {col.title} <span class="muted small">{board.cards.filter((c) => c.column === col.id).length}</span>
            </h3>
            {board.cards
              .filter((c) => c.column === col.id)
              .map((c) => (
                <div key={c.id} class={`card ${c.state ?? ""}`} draggable onDragStart={() => setDragging(c.id)} onClick={() => setOpen(c.id)}>
                  <div class="card-title">{c.title}</div>
                  {c.projectId && <div class="muted small">{projects.find((p) => p.id === c.projectId)?.name ?? c.projectId}</div>}
                  <div class="card-meta small">
                    <span class={`who ${c.assignee}`}>{c.assignee === "agent" ? "агент" : "человек"}</span>
                    {c.state && <span>{STATE[c.state] ?? c.state}</span>}
                    {c.comments.length > 0 && <span class="muted">комм.: {c.comments.length}</span>}
                  </div>
                </div>
              ))}
            {(col.id === "backlog" || col.id === "todo") && <NewCard column={col.id} onCreate={(body) => run(() => api("/p/kanban/cards", { body }))} />}
          </div>
        ))}
      </div>
      {card && <CardDialog card={card} columns={board.columns} projects={projects} onClose={() => setOpen(undefined)} onPatch={(b) => patch(card.id, b)} onDelete={() => run(async () => {
        await api(`/p/kanban/cards/${card.id}`, { method: "DELETE" });
        setOpen(undefined);
      })} onStart={() => run(() => api(`/p/kanban/cards/${card.id}/start`, { method: "POST" }))} />}
    </section>
  );
}

function NewCard({ column, onCreate }: { column: string; onCreate: (body: Record<string, unknown>) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [forAgent, setForAgent] = useState(true);
  return (
    <form
      class="new-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        void onCreate({ title: title.trim(), column, assignee: forAgent ? "agent" : "human" }).then(() => setTitle(""));
      }}
    >
      <input placeholder="+ карточка" value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
      {title && (
        <label class="small">
          <input type="checkbox" checked={forAgent} onChange={(e) => setForAgent(e.currentTarget.checked)} /> агенту
        </label>
      )}
    </form>
  );
}

function CardDialog(props: {
  card: Card;
  columns: { id: string; title: string }[];
  projects: { id: string; name: string }[];
  onClose: () => void;
  onPatch: (body: Record<string, unknown>) => Promise<void>;
  onDelete: () => Promise<void>;
  onStart: () => Promise<void>;
}) {
  const { card } = props;
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [comment, setComment] = useState("");
  const dirty = title !== card.title || description !== card.description;
  return (
    <div class="overlay" onClick={props.onClose}>
      <div class="dialog" onClick={(e) => e.stopPropagation()}>
        <input class="dialog-title" value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
        <div class="row small">
          <select value={card.column} onChange={(e) => void props.onPatch({ column: e.currentTarget.value })}>
            {props.columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <select value={card.projectId ?? ""} onChange={(e) => void props.onPatch({ projectId: e.currentTarget.value })}>
            <option value="">без проекта</option>
            {props.projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select value={card.assignee} onChange={(e) => void props.onPatch({ assignee: e.currentTarget.value })}>
            <option value="agent">агент</option>
            <option value="human">человек</option>
          </select>
          {card.sessionId && <a href={href({ page: "chat", sessionId: card.sessionId })}>открыть чат</a>}
          <span class="muted">запусков: {card.runs}</span>
        </div>
        <textarea rows={6} placeholder="Описание задачи" value={description} onInput={(e) => setDescription(e.currentTarget.value)} />
        {dirty && <button onClick={() => void props.onPatch({ title, description })}>Сохранить</button>}
        <h4>Комментарии</h4>
        <ul class="comments">
          {card.comments.map((c, i) => (
            <li key={i}>
              <b>{c.by === "agent" ? "агент" : "человек"}:</b> {c.text}
            </li>
          ))}
        </ul>
        <form
          class="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (comment.trim()) void props.onPatch({ comment: comment.trim() }).then(() => setComment(""));
          }}
        >
          <input placeholder={card.column === "review" && card.assignee === "agent" ? "Замечание вернёт карточку агенту" : "Комментарий"} value={comment} onInput={(e) => setComment(e.currentTarget.value)} />
          <button type="submit" disabled={!comment.trim()}>
            Добавить
          </button>
        </form>
        <div class="row end">
          {card.column !== "doing" && <button onClick={() => void props.onStart()}>Запустить агентом</button>}
          <button class="danger" onClick={() => confirm("Удалить карточку?") && void props.onDelete()}>
            Удалить
          </button>
          <button class="link" onClick={props.onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
