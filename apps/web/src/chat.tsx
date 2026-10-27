import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, subscribe, type Pending, type SessionInfo, type SintyEvent } from "./api.js";
import { IconBrain, IconMic, IconPlus } from "./icons.js";
import { PluginTab, tabViewKey, type PluginTabInfo } from "./plugin-tab.js";
import { SupervisorView } from "./supervisor-ui.js";

const VIEW_KEY = "sinty.chatView";
const NO_TABS: PluginTabInfo[] = [];

/** A plugin view stays open when the user switches chats (you look at each chat's context in turn); Чат/Журнал do not persist. */
function savedView(tabs: PluginTabInfo[]): string {
  try {
    const v = localStorage.getItem(VIEW_KEY) ?? "";
    return tabs.some((t) => tabViewKey(t) === v) ? v : "chat";
  } catch {
    return "chat";
  }
}

interface ToolCall {
  callId: string;
  tool: string;
  args: unknown;
  state: "requested" | "approval" | "running" | "done" | "failed" | "denied";
  result?: unknown;
  error?: { code: string; message: string; hint?: string };
  reason?: string;
}

type Item =
  | { kind: "user"; key: string; text: string; ts: string; files: string[] }
  | { kind: "agent"; key: string; text: string; ts: string; interim?: boolean; name?: string }
  | { kind: "tool"; key: string; call: ToolCall }
  | { kind: "note"; key: string; tone: "info" | "warn" | "error"; text: string };

const REFRESH_ON = new Set(["turn.started", "turn.blocked", "turn.resumed", "turn.completed", "turn.failed", "turn.interrupted", "tool.call.approval_requested", "tool.call.approved", "tool.call.denied", "session.updated", "session.policy_grant", "task.completed", "task.progress"]);

function build(events: SintyEvent[]): Item[] {
  const items: Item[] = [];
  for (const e of events) {
    const d = e.data as Record<string, any>;
    const key = String(e.seq ?? e.id);
    switch (e.type) {
      case "message.user":
        items.push({ kind: "user", key, text: d.text, ts: e.ts, files: (d.attachments ?? []).map((a: { name?: string }) => a.name || "файл") });
        break;
      case "message.agent":
        if (d.text) items.push({ kind: "agent", key, text: d.text, ts: e.ts, name: d.agentName });
        break;
      case "model.response":
      case "tool.call.requested":
      case "tool.call.approval_requested":
      case "tool.call.approved":
      case "tool.call.started":
      case "tool.call.completed":
      case "tool.call.failed":
      case "tool.call.denied":
        break;
      case "supervisor.notice":
        items.push({ kind: "note", key, tone: "warn", text: `Супервизор (${d.detector}): ${d.text}` });
        break;
      case "supervisor.escalated":
        items.push({ kind: "note", key, tone: "error", text: `Супервизор остановил работу (${d.detector}): ${d.reason}` });
        break;
      case "turn.failed":
        items.push({ kind: "note", key, tone: "error", text: `Ошибка: ${d.code} — ${d.message}` });
        break;
      case "turn.interrupted":
        items.push({ kind: "note", key, tone: "info", text: "Остановлено" });
        break;
      case "turn.blocked":
        if (d.reason === "budget") items.push({ kind: "note", key, tone: "warn", text: `Бюджет хода исчерпан${d.detail ? `: ${d.detail}` : ""}. Напишите сообщение, чтобы продолжить.` });
        break;
      case "plugin.patch.proposed":
        items.push({ kind: "note", key, tone: "info", text: `Предложен патч плагина ${d.plugin}: ${d.reason}` });
        break;
      case "plugin.patch.applied":
        items.push({ kind: "note", key, tone: "info", text: `Патч ${d.patchId} применён` });
        break;
      case "plugin.patch.rolled_back":
        items.push({ kind: "note", key, tone: "warn", text: `Патч ${d.patchId} откатан: ${d.reason}` });
        break;
      case "task.progress":
      case "task.completed":
        // Live status is rendered once below the log (see liveBgStatus); full history stays in Журнал.
        break;
    }
  }
  return items;
}


function progressLabel(phase: string): string {
  if (phase === "tool.started") return "работает";
  if (phase === "tool.completed") return "готово";
  if (phase === "tool.denied") return "отказано";
  if (phase === "tool.failed") return "ошибка";
  if (phase === "approval") return "ждёт апрув";
  if (phase === "blocked") return "стоит";
  return phase;
}

/** Open turn: the latest short reply (replaced in one bubble) and the tool line under it. */
function liveTurn(events: SintyEvent[]): { text: string; tool: string; warn: boolean } | null {
  let open = false;
  let text = "";
  let tool = "";
  let warn = false;
  const stateWord: Record<string, string> = {
    "tool.call.requested": "запрошен",
    "tool.call.approval_requested": "ждёт разрешения",
    "tool.call.approved": "выполняется",
    "tool.call.started": "выполняется",
    "tool.call.completed": "готово",
    "tool.call.failed": "ошибка",
    "tool.call.denied": "отклонён",
  };
  for (const e of events) {
    const d = e.data as Record<string, any>;
    if (e.type === "turn.started") {
      open = true;
      text = "";
      tool = "";
      warn = false;
    }
    if (e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted") {
      open = false;
      tool = "";
      text = "";
    }
    if (e.type === "model.response" && open && typeof d.text === "string" && d.text.trim()) text = d.text.trim();
    if (e.type === "message.agent") {
      text = "";
      if (!open) tool = "";
    }
    if (open && e.type.startsWith("tool.call.")) {
      tool = `${d.tool ?? "инструмент"} · ${stateWord[e.type] ?? ""}`;
      warn = e.type === "tool.call.failed" || e.type === "tool.call.denied";
    }
    if (e.type === "task.progress") {
      tool = `Фон · ${progressLabel(String(d.phase ?? ""))}${d.tool ? ` ${d.tool}` : ""}`;
      warn = d.phase === "tool.failed" || d.phase === "tool.denied" || d.phase === "blocked";
    }
    if (e.type === "task.completed" && !open) {
      const status = d.status === "completed" ? "готово" : d.status === "failed" ? "ошибка" : "прервано";
      tool = `Фон · ${status}`;
      warn = d.status !== "completed";
    }
  }
  if (!text && !tool && !open) return null;
  return { text, tool, warn };
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function show(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

export function Chat({ sessionId, onChange, tabs = NO_TABS }: { sessionId: string; onChange: () => void; tabs?: PluginTabInfo[] }) {
  const [events, setEvents] = useState<SintyEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [info, setInfo] = useState<SessionInfo & { pending: Pending | null; childPending?: Pending[]; childBusy?: number }>();
  const [childPending, setChildPending] = useState<Pending[]>([]);
  const [view, setView] = useState<string>(() => savedView(tabs));
  // /v1/plugins may answer after the chat mounted: restore a saved plugin view once its tab is known.
  useEffect(() => {
    if (view === "chat") {
      const saved = savedView(tabs);
      if (saved !== "chat") setView(saved);
    }
  }, [tabs]);
  const pluginTab = tabs.find((t) => tabViewKey(t) === view);
  const supCount = useMemo(() => events.filter((e) => e.type === "supervisor.notice" || e.type === "supervisor.escalated").length, [events]);
  const tab = pluginTab ? "plugin" : view === "journal" ? "journal" : view === "supervisor" ? "supervisor" : "chat";
  const setTab = (v: string): void => {
    setView(v);
    try {
      if (v.startsWith("tab:")) localStorage.setItem(VIEW_KEY, v);
      else localStorage.removeItem(VIEW_KEY);
    } catch {
      /* storage off: the view just does not persist */
    }
  };
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  const [replyAgent, setReplyAgent] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadInfo = async (): Promise<void> => {
    const data = await api<SessionInfo & { pending: Pending | null; childPending?: Pending[]; childBusy?: number }>(`/v1/sessions/${encodeURIComponent(sessionId)}`);
    setInfo(data);
    setChildPending(data.childPending ?? []);
  };

  // Same rule as the core (Agent.speaker): the chat's own agentIds, else the project's agents; lead answers by default.
  const [membersKnown, setMembersKnown] = useState(false);
  useEffect(() => {
    if (!info) return;
    const projectId = info.projectId;
    const picked = Array.isArray(info.metadata?.agentIds) ? (info.metadata.agentIds as unknown[]).filter((id): id is string => typeof id === "string") : [];
    if (!projectId && picked.length === 0) {
      setMembers([]);
      setMembersKnown(true);
      return;
    }
    void Promise.all([
      api<{ agents: { id: string; name: string }[] }>("/v1/roster/agents"),
      projectId ? api<{ projects: { id: string; leadId: string; agentIds: string[] }[] }>("/v1/roster/projects") : Promise.resolve({ projects: [] as { id: string; leadId: string; agentIds: string[] }[] }),
    ]).then(([a, p]) => {
      const project = p.projects.find((x) => x.id === projectId);
      const ids = picked.length ? picked : project?.agentIds ?? [];
      const list = a.agents.filter((agent) => ids.includes(agent.id));
      const lead = project?.leadId && list.some((m) => m.id === project.leadId) ? project.leadId : "";
      setMembers(list);
      setMembersKnown(true);
      setReplyAgent((cur) => (cur && list.some((m) => m.id === cur) ? cur : lead || list[0]?.id || ""));
    }).catch(() => {
      setMembers([]);
      setMembersKnown(false);
    });
  }, [info?.projectId, info?.metadata]);

  useEffect(() => {
    void loadInfo().catch((e: unknown) => setError(String(e)));
    let seen = 0;
    return subscribe(
      (lastId) => `/v1/sessions/${encodeURIComponent(sessionId)}/stream?after=${lastId ?? seen}`,
      (m) => {
        const e = JSON.parse(m.data) as SintyEvent;
        if (e.type === "model.delta") {
          let streamOn = true;
          try {
            const prefs = JSON.parse(localStorage.getItem("sinty.prefs") || "{}") as { streaming?: boolean };
            streamOn = prefs.streaming !== false;
          } catch {
            /* default on */
          }
          if (!streamOn) return;
          const t = (e.data as { text?: string }).text;
          if (t) setStreaming((s) => s + t);
          return;
        }
        if (e.type === "tool.call.progress") return;
        if (e.seq !== undefined) {
          if (e.seq <= seen) return;
          seen = e.seq;
        }
        if (e.type === "model.response" || e.type === "model.request" || e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted") setStreaming("");
        setEvents((list) => [...list, e]);
        if (REFRESH_ON.has(e.type)) {
          if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
          refreshTimer.current = setTimeout(() => {
            void loadInfo();
            onChange();
          }, 150);
        }
      },
    );
  }, [sessionId]);

  // Child agent.task approvals land on the child session stream; watch the global bus so the parent chat refreshes.
  useEffect(() => {
    return subscribe(
      () => "/v1/stream",
      (m) => {
        const e = JSON.parse(m.data) as SintyEvent;
        if (
          e.type === "turn.blocked" ||
          e.type === "tool.call.approval_requested" ||
          e.type === "tool.call.approved" ||
          e.type === "tool.call.denied" ||
          e.type === "turn.resumed" ||
          e.type === "turn.completed" ||
          e.type === "turn.failed" ||
          e.type === "turn.interrupted" ||
          e.type === "task.completed"
        ) {
          if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
          refreshTimer.current = setTimeout(() => void loadInfo(), 150);
        }
      },
    );
  }, [sessionId]);

  const items = useMemo(() => build(events), [events]);
  const presence = useMemo(() => liveTurn(events), [events]);
  const liveText = streaming || presence?.text || "";
  const toolLine = presence?.tool ?? "";
  useEffect(() => {
    if (tab !== "chat") return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tab, items.length, liveText, presence?.tool, streaming, info?.pending, childPending.length]);

  const pending = info?.pending ?? null;
  const childApprovals = childPending.filter((p) => p.reason === "approval" && p.approvals.length > 0);
  const childApprovalCount = childApprovals.reduce((n, p) => n + p.approvals.length, 0);
  const parentApprovalCount = pending?.reason === "approval" ? pending.approvals.length : 0;
  const running = info?.activeTurn?.status === "running";
  const canStop = running || info?.activeTurn?.status === "blocked" || (info?.childBusy ?? 0) > 0;
  const policyTrust = info?.metadata?.policyTrust === true;

  const [files, setFiles] = useState<{ name: string; blob: string; mime: string; bytes: number }[]>([]);

  const addFiles = async (list: FileList | null): Promise<void> => {
    if (!list?.length) return;
    setError("");
    for (const file of [...list].slice(0, 8 - files.length)) {
      const dataBase64 = toBase64(await file.arrayBuffer());
      const ref = await api<typeof files[number]>("/v1/blobs", { body: { name: file.name, mime: file.type || "application/octet-stream", dataBase64 } });
      setFiles((cur) => [...cur, { name: file.name, blob: ref.blob, mime: ref.mime, bytes: ref.bytes }]);
    }
  };

  const send = async (e?: Event): Promise<void> => {
    e?.preventDefault();
    const text = draft.trim();
    if ((!text && files.length === 0) || sending) return;
    setSending(true);
    setError("");
    try {
      await api(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
        body: { text, channel: "web", ...(replyAgent ? { agentId: replyAgent } : {}), ...(files.length ? { attachments: files.map(({ name, blob, mime, bytes }) => ({ name, blob, mime, bytes })) } : {}) },
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      setDraft("");
      setFiles([]);
      await loadInfo();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const decide = async (
    callId: string,
    decision: "approve" | "deny",
    targetSessionId: string = sessionId,
    remember = false,
  ): Promise<void> => {
    try {
      await api(`/v1/sessions/${encodeURIComponent(targetSessionId)}/approvals/${encodeURIComponent(callId)}`, {
        body: { decision, ...(remember ? { remember: true } : {}) },
      });
      await loadInfo();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Session trust: skip further policy asks in this chat; approve everything currently waiting. */
  const grantTrust = async (): Promise<void> => {
    try {
      await api(`/v1/sessions/${encodeURIComponent(sessionId)}/policy-grants`, { body: { trust: true, note: "ui remember" } });
      await loadInfo();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const interrupt = async (): Promise<void> => {
    await api(`/v1/sessions/${encodeURIComponent(sessionId)}/stop-all`, { method: "POST" });
    await loadInfo();
  };

  const placeholder =
    pending?.reason === "ask_human"
      ? `Агент спрашивает: ${pending.detail ?? ""}`
      : pending?.reason === "supervisor" || pending?.reason === "budget"
        ? "Ответьте, чтобы продолжить работу"
        : "Сообщение агенту… (Enter — отправить, Shift+Enter — перенос)";

  return (
    <section class="chat">
      <header class="bar">
        <h2>{info?.title || sessionId}</h2>
        {members.length > 0 && (
          <select value={replyAgent} onChange={(e) => setReplyAgent(e.currentTarget.value)}>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        )}
        <span class={`status ${info?.activeTurn?.status ?? "idle"}`}>{running ? "работает" : info?.activeTurn?.status === "blocked" ? "ждёт" : "свободен"}</span>
        <div class="tabs">
          <button class={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>
            Чат
          </button>
          <button class={tab === "journal" ? "on" : ""} onClick={() => setTab("journal")}>
            Журнал
          </button>
          <button class={tab === "supervisor" ? "on" : ""} title="Замечания и инциденты супервизора в этом чате" onClick={() => setTab("supervisor")}>
            Супервизор{supCount > 0 && <span class="badge">{supCount}</span>}
          </button>
          {tabs.map((t) => (
            <button key={tabViewKey(t)} class={pluginTab === t ? "on" : ""} title={`Вкладка плагина ${t.plugin}`} onClick={() => setTab(tabViewKey(t))}>
              {t.title}
            </button>
          ))}
        </div>
        {canStop && (
          <button class="danger" title="Прервать этот ход и все дочерние agent.task, в том числе уже остановленные супервизором" onClick={() => void interrupt()}>
            Стоп всё
          </button>
        )}
      </header>
      {membersKnown && members.length === 0 && info?.projectId && (
        <div class="banner soon" role="status">
          <span class="grow">
            В этом чате и в его проекте нет агентов. Отвечает агент по умолчанию с глобальным <code>~/.sinty/AGENTS.md</code>, а не карточка агента.
            Добавьте агентов в проект на странице «Агенты» или создайте чат через «+» у проекта с выбором участников.
          </span>
        </div>
      )}

      {pluginTab ? (
        <div class="session-tab">
          <PluginTab key={tabViewKey(pluginTab)} tab={pluginTab} sessionId={sessionId} />
        </div>
      ) : tab === "journal" ? (
        <Journal events={events} />
      ) : tab === "supervisor" ? (
        <div class="session-tab">
          <SupervisorView sessionId={sessionId} tick={supCount} />
        </div>
      ) : (
        <div class="log" ref={logRef}>
          {items.map((it) => {
            switch (it.kind) {
              case "user":
                return (
                  <div key={it.key} class="msg user">
                    {it.files.length > 0 && (
                      <div class="files">
                        {it.files.map((name) => (
                          <span>{name}</span>
                        ))}
                      </div>
                    )}
                    {it.text}
                  </div>
                );
              case "agent":
                return (
                  <div key={it.key} class={`msg agent${it.interim ? " interim" : ""}`}>
                    {it.name && <div class="muted small">{it.name}</div>}
                    {it.text}
                  </div>
                );
              case "note":
                return (
                  <div key={it.key} class={`note ${it.tone}`}>
                    {it.text}
                  </div>
                );
              case "tool":
                return null;
            }
          })}
          {liveText && <div class="msg agent interim">{liveText}</div>}
          {(toolLine || (running && !liveText)) && (
            <div class={`typing shimmer${presence?.warn ? " warn" : ""}`} aria-live="polite">
              {toolLine || "Агент думает…"}
            </div>
          )}
          <div ref={bottom} />
        </div>
      )}

      {childApprovals.length > 0 && tab === "chat" && !pluginTab && (
        <div class="child-approvals">
          <div class="menu-label">
            Фоновая задача ждёт одобрения
            {childApprovalCount > 1 && <span class="badge">{childApprovalCount}</span>}
          </div>
          <div class="approval-list">
            {childApprovals.flatMap((p) => p.approvals.map((a) => (
              <ToolCard
                key={`${p.sessionId}:${a.callId}`}
                call={{ callId: a.callId, tool: a.tool, args: a.args, state: "approval", reason: a.reason }}
                onDecide={(callId, d) => decide(callId, d, p.sessionId)}
              />
            )))}
          </div>
          <div class="approvals">
            {childApprovalCount > 1 && <span>Ждут решения: {childApprovalCount}</span>}
            {childApprovalCount > 1 && (
              <button onClick={() => childApprovals.forEach((p) => p.approvals.forEach((a) => void decide(a.callId, "approve", p.sessionId)))}>
                Одобрить все
              </button>
            )}
            {!policyTrust && (
              <button title="Больше не спрашивать разрешения в этом чате (в журнале всё равно видно)" onClick={() => void grantTrust()}>
                Больше не спрашивать в этом чате
              </button>
            )}
          </div>
        </div>
      )}

      {pending?.reason === "approval" && parentApprovalCount > 0 && tab === "chat" && !pluginTab && (
        <div class="child-approvals">
          <div class="menu-label">Нужно разрешение{parentApprovalCount > 1 ? ` · ${parentApprovalCount}` : ""}</div>
          <div class="approval-list">
            {pending.approvals.map((a) => (
              <ToolCard
                key={a.callId}
                call={{ callId: a.callId, tool: a.tool, args: a.args, state: "approval", reason: a.reason }}
                onDecide={(callId, d) => decide(callId, d)}
              />
            ))}
          </div>
          <div class="approvals">
            {parentApprovalCount > 1 && (
              <button onClick={() => pending.approvals.forEach((a) => void decide(a.callId, "approve"))}>Одобрить все</button>
            )}
            {!policyTrust && (
              <button title="Больше не спрашивать разрешения в этом чате" onClick={() => void grantTrust()}>
                Больше не спрашивать в этом чате
              </button>
            )}
          </div>
        </div>
      )}

      <form class="composer" onSubmit={send}>
        <div class="composer-card">
          {files.length > 0 && (
            <div class="files">
              {files.map((f) => (
                <span>
                  {f.name}
                  <button type="button" onClick={() => setFiles(files.filter((x) => x !== f))}>×</button>
                </span>
              ))}
            </div>
          )}
          <textarea
            value={draft}
            placeholder={placeholder}
            rows={Math.min(8, Math.max(2, draft.split("\n").length))}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div class="composer-bar">
            <label class="icon composer-plus" title="Файл">
              <IconPlus />
              <input type="file" multiple accept="image/*,.pdf,.xlsx,.csv,.txt,.md,.json" onChange={(e) => void addFiles(e.currentTarget.files)} />
            </label>
            {members.length > 0 && (
              <span class="composer-model"><IconBrain /> {members.find((m) => m.id === replyAgent)?.name}</span>
            )}
            <span class="grow" />
            <button class="composer-send" type="submit" aria-label="Отправить" disabled={(!draft.trim() && files.length === 0) || sending}>
              {draft.trim() || files.length ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5M6 11l6-6 6 6" /></svg>
              ) : <IconMic />}
            </button>
          </div>
        </div>
      </form>
      {error && <p class="error">{error}</p>}
    </section>
  );
}

function ToolCard({ call, onDecide }: { call: ToolCall; onDecide: ((callId: string, d: "approve" | "deny") => Promise<void>) | undefined }) {
  const [open, setOpen] = useState(false);
  const label: Record<ToolCall["state"], string> = { requested: "запрошен", approval: "ждёт одобрения", running: "выполняется", done: "готово", failed: "ошибка", denied: "отклонён" };
  return (
    <div class={`tool ${call.state}`}>
      <div class="tool-head" onClick={() => setOpen(!open)}>
        <code>{call.tool}</code>
        <span class="small">{label[call.state]}</span>
        <span class="muted small">{open ? "▾" : "▸"}</span>
      </div>
      {(open || call.state === "approval") && (
        <div class="tool-body">
          <pre>{show(call.args)}</pre>
          {call.reason && <p class="muted small">{call.reason}</p>}
          {call.state === "done" && open && call.tool === "agent.task" && call.result && typeof call.result === "object" && "text" in (call.result as object) && (
            <p>{String((call.result as { text: string }).text)}</p>
          )}
          {call.state === "done" && open && <pre class="result">{show(call.result)}</pre>}
          {call.error && (
            <p class="error small">
              {call.error.code}: {call.error.message}
              {call.error.hint && <br />}
              {call.error.hint}
            </p>
          )}
        </div>
      )}
      {onDecide && (
        <div class="tool-actions">
          <button onClick={() => void onDecide(call.callId, "approve")}>Одобрить</button>
          <button class="danger" onClick={() => void onDecide(call.callId, "deny")}>
            Отклонить
          </button>
        </div>
      )}
    </div>
  );
}

function laneOf(type: string): "input" | "model" | "tool" {
  if (type.startsWith("tool.")) return "tool";
  if (type.startsWith("message.agent") || type.startsWith("model.")) return "model";
  return "input";
}

function eventPreview(data: Record<string, unknown>): string {
  for (const key of ["text", "message", "summary", "name", "tool", "reason"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 280);
  }
  return "";
}

function Journal({ events }: { events: SintyEvent[] }) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  const [showDuration, setShowDuration] = useState(true);
  const [showTurns, setShowTurns] = useState(true);
  const [showCalls, setShowCalls] = useState(true);
  const [picked, setPicked] = useState(0);
  const rows = events.filter((e) => showCalls || !e.type.startsWith("tool."));
  const selected = rows[Math.min(picked, Math.max(0, rows.length - 1))];
  const start = rows.length ? Date.parse(rows[0]!.ts) : 0;
  const end = rows.length ? Date.parse(rows[rows.length - 1]!.ts) : start;
  const span = Math.max(1, end - start);
  const turns = new Map<string, SintyEvent[]>();
  for (const event of rows) {
    const key = event.turnId || "до хода";
    turns.set(key, [...(turns.get(key) ?? []), event]);
  }
  return (
    <div class="trace">
      <div class="trace-tools">
        <label><input type="checkbox" checked={showDuration} onChange={() => setShowDuration(!showDuration)} /> Длительность</label>
        <label><input type="checkbox" checked={showTurns} onChange={() => setShowTurns(!showTurns)} /> Ходы</label>
        <label><input type="checkbox" checked={showCalls} onChange={() => setShowCalls(!showCalls)} /> Вызовы</label>
      </div>
      {showDuration && rows.length > 0 && (
        <div class="trace-plot">
          <div class="trace-lanes"><span>Ввод</span><span>Модель</span><span>Вызовы</span></div>
          <div class="trace-track">
            {[...turns.keys()].slice(1).map((turn) => {
              const first = turns.get(turn)?.[0];
              if (!first) return null;
              const left = (Date.parse(first.ts) - start) / span * 100;
              return <i key={turn} class="trace-bound" style={{ left: `${left}%` }} />;
            })}
            {rows.map((event, i) => {
              const next = rows[i + 1];
              const left = (Date.parse(event.ts) - start) / span * 100;
              const width = Math.max(0.4, ((next ? Date.parse(next.ts) : end + span * 0.02) - Date.parse(event.ts)) / span * 100);
              return (
                <button
                  key={event.seq ?? i}
                  type="button"
                  class={`seg lane-${laneOf(event.type)} ${selected === event ? "on" : ""}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={eventPreview(event.data) || event.type}
                  onClick={() => setPicked(i)}
                />
              );
            })}
          </div>
        </div>
      )}
      <div class="trace-body">
        <div class="trace-list" ref={listRef}>
          {[...turns.entries()].map(([turn, list], index) => (
            <div key={turn}>
              {showTurns && <div class="trace-turn">Ход {index + 1}</div>}
              {list.map((event) => {
                const i = rows.indexOf(event);
                const preview = eventPreview(event.data);
                return (
                  <button key={event.seq ?? event.id} type="button" class={`trace-row ${selected === event ? "on" : ""}`} onClick={() => setPicked(i)}>
                    <span class={`pill lane-${laneOf(event.type)}`}>{laneOf(event.type) === "input" ? "Ввод" : laneOf(event.type) === "model" ? "Модель" : "Вызов"}</span>
                    <span class="trace-text">{preview || event.type}</span>
                    <span class="muted small">{new Date(event.ts).toLocaleTimeString()}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {selected && (
          <aside class="trace-side">
            <b>{selected.type}</b>
            <p class="small muted">{selected.actor ? `${selected.actor.kind}:${selected.actor.id}` : "без автора"} · {new Date(selected.ts).toLocaleString()}</p>
            {eventPreview(selected.data) && <p>{eventPreview(selected.data)}</p>}
            <pre>{JSON.stringify(selected.data, null, 2)}</pre>
          </aside>
        )}
      </div>
    </div>
  );
}
