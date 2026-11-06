import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, subscribe, token, type Pending, type SessionInfo, type SintyEvent } from "./api.js";
import { IconArrowUp, IconMic, IconPlus, IconWave } from "./icons.js";
import { Markdown } from "./markdown.js";
import { MediaView } from "./media.js";
import { mergeMedia, splitMedia, type MediaRef } from "./media-ref.js";
import { PluginTab, tabViewKey, type PluginTabInfo } from "./plugin-tab.js";
import { waitNote } from "./wait-note.js";
import { SupervisorView } from "./supervisor-ui.js";

const VIEW_KEY = "sinty.chatView";
const NO_TABS: PluginTabInfo[] = [];

type SpeechRec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
};

function speechSupported(): boolean {
  const w = window as typeof window & { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

function makeSpeechRec(): SpeechRec | null {
  const w = window as typeof window & { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}


/** What the chat pane draws. Tool results stay in the journal file; one film chat holds about 150 MB of them. */
const CHAT_TYPES = [
  "message.user",
  "message.agent",
  "chat.media",
  "supervisor.notice",
  "supervisor.escalated",
  "turn.failed",
  "turn.interrupted",
  "turn.blocked",
  "turn.started",
  "turn.completed",
  "plugin.patch.proposed",
  "plugin.patch.applied",
  "plugin.patch.rolled_back",
  "task.completed",
  "model.response",
  "tool.call.requested",
  "tool.call.approval_requested",
  "tool.call.approved",
  "tool.call.started",
  "tool.call.failed",
  "tool.call.denied",
].join(",");

const transcriptCache = new Map<string, SintyEvent[]>();
const transcriptTail = new Map<string, number>();
const transcriptLoad = new Map<string, Promise<{ events: SintyEvent[]; lastSeq: number }>>();

function sameTranscript(a: SintyEvent[], b: SintyEvent[]): boolean {
  return a.length === b.length && (a.length === 0 || a[a.length - 1]?.seq === b[b.length - 1]?.seq);
}

/** Reads the messages the pane shows and remembers them, so the next open does not start blank. */
export function prefetchTranscript(sessionId: string): Promise<{ events: SintyEvent[]; lastSeq: number }> {
  const cached = transcriptCache.get(sessionId);
  if (cached) return Promise.resolve({ events: cached, lastSeq: transcriptTail.get(sessionId) ?? 0 });
  const ready = transcriptLoad.get(sessionId);
  if (ready) return ready;
  const job = (async () => {
    const events: SintyEvent[] = [];
    let after = 0;
    let lastSeq = 0;
    for (;;) {
      const page = await api<{ events: SintyEvent[]; lastSeq?: number }>(`/v1/sessions/${encodeURIComponent(sessionId)}/events?after=${after}&limit=2000&types=${encodeURIComponent(CHAT_TYPES)}`);
      if (typeof page.lastSeq === "number") lastSeq = page.lastSeq;
      const batch = page.events ?? [];
      if (!batch.length) break;
      events.push(...batch);
      const tail = batch[batch.length - 1]?.seq ?? after;
      if (tail <= after || batch.length < 2000) break;
      after = tail;
    }
    transcriptCache.set(sessionId, events);
    transcriptTail.set(sessionId, lastSeq);
    return { events, lastSeq };
  })().finally(() => {
    transcriptLoad.delete(sessionId);
  });
  transcriptLoad.set(sessionId, job);
  return job;
}

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
  | { kind: "agent"; key: string; text: string; ts: string; interim?: boolean; name?: string; media: MediaRef[] }
  | { kind: "tool"; key: string; call: ToolCall }
  | { kind: "note"; key: string; tone: "info" | "warn" | "error"; text: string };

function mediaOf(value: unknown): MediaRef[] {
  if (!Array.isArray(value)) return [];
  const files: MediaRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as { path?: unknown; kind?: unknown };
    if (typeof row.path !== "string") continue;
    if (row.kind !== "audio" && row.kind !== "video" && row.kind !== "image") continue;
    files.push({ path: row.path, kind: row.kind });
  }
  return files;
}

const REFRESH_ON = new Set(["turn.started", "turn.blocked", "turn.resumed", "turn.completed", "turn.failed", "turn.interrupted", "tool.call.approval_requested", "tool.call.approved", "tool.call.denied", "session.updated", "session.policy_grant", "task.completed", "task.progress"]);

function build(events: SintyEvent[]): Item[] {
  const items: Item[] = [];
  let pending: MediaRef[] = [];
  const flush = (): void => {
    if (!pending.length) return;
    items.push({ kind: "agent", key: `media-${items.length}`, text: "", ts: "", media: pending });
    pending = [];
  };
  for (const e of events) {
    const d = e.data as Record<string, any>;
    const key = String(e.seq ?? e.id);
    switch (e.type) {
      case "chat.media":
        pending = mergeMedia(pending, mediaOf(d.files));
        break;
      case "message.user":
        flush();
        items.push({ kind: "user", key, text: d.text, ts: e.ts, files: (d.attachments ?? []).map((a: { name?: string }) => a.name || "файл") });
        break;
      case "message.agent":
        if (d.text || pending.length) items.push({ kind: "agent", key, text: d.text ?? "", ts: e.ts, name: d.agentName, media: pending });
        pending = [];
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
      case "supervisor.escalated":
        break;
      case "turn.failed":
        items.push({ kind: "note", key, tone: "error", text: `Ошибка: ${d.code} — ${d.message}` });
        break;
      case "turn.interrupted":
        items.push({ kind: "note", key, tone: "info", text: "Остановлено" });
        break;
      case "turn.blocked":
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
  flush();
  return items;
}

function AgentBody({ text, media, sessionId }: { text: string; media: MediaRef[]; sessionId: string }) {
  const parsed = splitMedia(text);
  const files = mergeMedia(media, parsed.files);
  return (
    <>
      {parsed.text && <Markdown text={parsed.text} />}
      {files.map((file) => <MediaView key={file.path} sessionId={sessionId} file={file} />)}
    </>
  );
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

function show(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

export function Chat({ sessionId, title = "", projectName, onChange, tabs = NO_TABS, studio = false, studioTab = null, onStudio }: { sessionId: string; title?: string; projectName?: string; onChange: () => void; tabs?: PluginTabInfo[]; studio?: boolean; studioTab?: PluginTabInfo | null; onStudio?: (open: boolean) => void }) {
  const [events, setEvents] = useState<SintyEvent[]>(() => transcriptCache.get(sessionId) ?? []);
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
  /** Synchronous lock: two clicks can both see `sending === false` before React re-renders. */
  const sendGuard = useRef(false);
  /** Same key until this exact payload is accepted, so a retry does not open a second turn. */
  const pendingSend = useRef<{ key: string; fingerprint: string } | null>(null);
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
    let stop = (): void => {};
    let cancelled = false;
    const take = (m: { data: string }): void => {
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
        transcriptTail.set(sessionId, seen);
      }
      if (e.type === "model.response" || e.type === "model.request" || e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted") setStreaming("");
      setEvents((list) => {
        const next = [...list, e];
        transcriptCache.set(sessionId, next);
        return next;
      });
      if (REFRESH_ON.has(e.type)) {
        if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => {
          void loadInfo();
          onChange();
        }, 150);
      }
    };
    // Messages only. The stream starts at the session tail, so tool results already in the file are not replayed.
    void prefetchTranscript(sessionId).then((page) => {
      if (cancelled) return;
      const tail = page.events[page.events.length - 1]?.seq ?? 0;
      seen = Math.max(page.lastSeq, tail);
      setEvents((cur) => (sameTranscript(cur, page.events) ? cur : page.events));
      stop = subscribe(
        (lastId) => `/v1/sessions/${encodeURIComponent(sessionId)}/stream?after=${lastId ?? seen}`,
        take,
      );
    }).catch((e: unknown) => {
      if (!cancelled) setError(String(e));
    });
    return () => {
      cancelled = true;
      stop();
    };
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
  useLayoutEffect(() => {
    if (tab !== "chat") return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tab, items.length, liveText, presence?.tool, streaming]);

  const pending = info?.pending ?? null;
  const childApprovals = childPending.filter((p) => p.reason === "approval" && p.approvals.length > 0);
  const childApprovalCount = childApprovals.reduce((n, p) => n + p.approvals.length, 0);
  const parentApprovalCount = pending?.reason === "approval" ? pending.approvals.length : 0;
  const running = info?.activeTurn?.status === "running";
  const canStop = running || info?.activeTurn?.status === "blocked" || (info?.childBusy ?? 0) > 0;
  const policyTrust = info?.metadata?.policyTrust === true;

  const [files, setFiles] = useState<{ name: string; blob: string; mime: string; bytes: number }[]>([]);
  const [uploading, setUploading] = useState("");
  const [uploadsLeft, setUploadsLeft] = useState(0);
  const uploadsRef = useRef(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [composerTall, setComposerTall] = useState(false);
  const [recording, setRecording] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [voiceHint, setVoiceHint] = useState("");
  const recogRef = useRef<SpeechRec | null>(null);
  const spokenRef = useRef("");
  const holdingRef = useRef(false);

  const addFiles = async (list: FileList | null): Promise<void> => {
    if (!list?.length) return;
    setError("");
    const room = 8 - files.length - uploadsRef.current;
    const queued = [...list].slice(0, Math.max(0, room)).filter((file) => {
      if (file.size <= 8 * 1024 * 1024 * 1024) return true;
      setError(`${file.name}: файл больше 8 ГБ`);
      return false;
    });
    if (!queued.length) return;
    uploadsRef.current += queued.length;
    setUploadsLeft(uploadsRef.current);
    for (const file of queued) {
      setUploading(file.name);
      try {
        const res = await fetch(`/v1/blobs?name=${encodeURIComponent(file.name)}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token.get()}`, "content-type": file.type || "application/octet-stream" },
          body: file,
        });
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string }; blob?: string; mime?: string; bytes?: number; name?: string };
        if (!res.ok || !body.blob) throw new Error(body.error?.message || `загрузка не прошла (${res.status})`);
        setFiles((cur) => [...cur, { name: body.name || file.name, blob: body.blob!, mime: body.mime || file.type || "application/octet-stream", bytes: body.bytes ?? file.size }]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        uploadsRef.current = Math.max(0, uploadsRef.current - 1);
        setUploadsLeft(uploadsRef.current);
        if (uploadsRef.current === 0) setUploading("");
      }
    }
  };

  const send = async (e?: Event): Promise<void> => {
    e?.preventDefault();
    const text = draft.trim();
    if (uploadsRef.current > 0 || (!text && files.length === 0) || sendGuard.current) return;
    sendGuard.current = true;
    setSending(true);
    setError("");
    const fingerprint = JSON.stringify({
      text,
      agentId: replyAgent,
      blobs: files.map((f) => f.blob),
    });
    const key = pendingSend.current?.fingerprint === fingerprint ? pendingSend.current.key : crypto.randomUUID();
    pendingSend.current = { key, fingerprint };
    try {
      await api(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
        body: { text, channel: "web", ...(replyAgent ? { agentId: replyAgent } : {}), ...(files.length ? { attachments: files.map(({ name, blob, mime, bytes }) => ({ name, blob, mime, bytes })) } : {}) },
        headers: { "idempotency-key": key },
      });
      pendingSend.current = null;
      setDraft("");
      setFiles([]);
      await loadInfo();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      sendGuard.current = false;
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

  const [stopping, setStopping] = useState(false);
  const interrupt = async (): Promise<void> => {
    if (stopping) return;
    setStopping(true);
    setError("");
    try {
      await api(`/v1/sessions/${encodeURIComponent(sessionId)}/stop-all`, { method: "POST" });
      await loadInfo();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  };

  useLayoutEffect(() => {
    const el = taRef.current;
    const card = cardRef.current;
    if (!el || !card) return;
    const LINE = 20;
    const MAX = LINE * 6;
    const hasAtts = files.length > 0 || uploadsLeft > 0;
    const apply = (isTall: boolean, h: number): void => {
      card.classList.toggle("tall", isTall);
      if (isTall) {
        el.style.maxHeight = `${MAX}px`;
        el.style.height = `${Math.min(MAX, Math.max(LINE, h))}px`;
        el.classList.toggle("scrollable", h > MAX);
      } else {
        el.style.height = `${LINE}px`;
        el.style.maxHeight = `${LINE}px`;
        el.classList.remove("scrollable");
      }
    };
    if (hasAtts || /\n/.test(draft)) {
      card.classList.add("tall");
      el.style.maxHeight = `${MAX}px`;
      el.style.height = "auto";
      apply(true, el.scrollHeight);
      if (!composerTall) setComposerTall(true);
      return;
    }
    card.classList.remove("tall");
    el.style.maxHeight = "none";
    el.style.height = "auto";
    const h = el.scrollHeight;
    if (h > LINE + 1) {
      card.classList.add("tall");
      el.style.maxHeight = `${MAX}px`;
      el.style.height = "auto";
      apply(true, el.scrollHeight);
      if (!composerTall) setComposerTall(true);
    } else {
      apply(false, h);
      if (composerTall) setComposerTall(false);
    }
  }, [draft, files.length, uploadsLeft, composerTall]);

  const startVoice = (e: PointerEvent): void => {
    e.preventDefault();
    (e.currentTarget as HTMLButtonElement).setPointerCapture?.(e.pointerId);
    holdingRef.current = true;
    setVoiceHint("");
    spokenRef.current = "";
    const rec = makeSpeechRec();
    if (!rec) {
      setRecording(true);
      recogRef.current = null;
      return;
    }
    rec.lang = "ru-RU";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      let text = "";
      for (let i = 0; i < ev.results.length; i++) {
        const row = ev.results[i];
        if (row && row[0]) text += row[0].transcript;
      }
      spokenRef.current = text;
    };
    rec.onerror = () => undefined;
    try {
      rec.start();
      recogRef.current = rec;
      setRecording(true);
    } catch {
      setRecording(true);
    }
  };
  const endVoice = (e: PointerEvent): void => {
    if (!holdingRef.current && !recogRef.current) return;
    holdingRef.current = false;
    e.preventDefault();
    try { recogRef.current?.stop(); } catch { /* already stopped */ }
    recogRef.current = null;
    setRecording(false);
    const spoken = spokenRef.current.trim();
    spokenRef.current = "";
    if (spoken) {
      setDraft((cur) => (cur ? `${cur.replace(/\s*$/, " ")}${spoken}` : spoken));
      return;
    }
    if (!speechSupported()) setVoiceHint("Голосовой ввод недоступен в этом браузере");
  };

  const waitWord = (reason: string): string => reason === "approval" ? "одобрение" : reason === "ask_human" ? "вопрос" : reason === "budget" ? "бюджет" : "супервизор";
  const childWait = childPending.find((p) => p.reason !== "approval");
  const queued = running && items.at(-1)?.kind === "user";
  const placeholder =
    pending?.reason === "ask_human"
      ? `Агент спрашивает: ${pending.detail ?? ""}`
      : childWait?.reason === "ask_human"
        ? `Фон спрашивает: ${childWait.detail ?? ""}`
        : childWait
          ? `Фон ждёт: ${waitWord(childWait.reason)}. ${childWait.detail ?? "Это не вопрос."}`
          : pending?.reason === "supervisor" || pending?.reason === "budget"
            ? "Ответьте, чтобы продолжить работу"
            : queued
              ? "Ход занят. Сообщение уже в очереди."
              : "Сообщение агенту… (Enter — отправить, Shift+Enter — перенос)";

  return (
    <>
    <section class="chat">
      <header class="bar">
        <div class="bar-crumb">
          {projectName && <span class="bar-proj">{projectName}</span>}
          {projectName && <span class="bar-sep">/</span>}
          <h2>{info?.title || title || "Чат"}</h2>
          {members.length > 0 && (
            <label class="agent-pill">
              <span class="agent-pill-av">{(members.find((m) => m.id === replyAgent)?.name ?? members[0]?.name ?? "?").slice(0, 1)}</span>
              <select value={replyAgent} onChange={(e) => setReplyAgent(e.currentTarget.value)}>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </label>
          )}
          <span class={`status ${info?.activeTurn?.status ?? "idle"}`}>{running ? "работает" : info?.activeTurn?.status === "blocked" ? "ждёт" : "свободен"}</span>
        </div>
        {studioTab && info?.projectId && (
          <button type="button" class={`studio-toggle${studio ? " on" : ""}`} title="Редактор рядом с чатом" onClick={() => onStudio?.(!studio)}>
            Видео
          </button>
        )}
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
          <button class="danger" title="Прервать этот ход и все дочерние agent.task, в том числе уже остановленные супервизором" disabled={stopping} onClick={() => void interrupt()}>
            {stopping ? "Останавливаю…" : "Стоп всё"}
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
                    <AgentBody text={it.text} media={it.media} sessionId={sessionId} />
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
          {liveText && (
            <div class="msg agent interim">
              <AgentBody text={liveText} media={[]} sessionId={sessionId} />
            </div>
          )}
          {(toolLine || (running && !liveText)) && (
            <div class={`typing shimmer${presence?.warn ? " warn" : ""}`} aria-live="polite">
              {toolLine || "Агент думает…"}
            </div>
          )}
          {pending && <div class="note warn">{waitNote(pending)}</div>}
          {childPending.map((p) => (
            <div key={p.turnId} class="note warn">{waitNote(p, true)}</div>
          ))}
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

      <form class="composer" onSubmit={(e) => { void send(e); }}>
        <div class={`composer-card${composerTall ? " tall" : ""}`} ref={cardRef}>
          {(files.length > 0 || uploading) && (
            <div class="composer-atts">
              {files.map((f) => (
                <span class="composer-att" title={f.name}>
                  {f.name}
                  <button type="button" onClick={() => setFiles(files.filter((x) => x !== f))}>×</button>
                </span>
              ))}
              {uploading && <span class="composer-att">Загрузка {uploading}…</span>}
            </div>
          )}
          <div class="composer-text">
            <textarea
              ref={taRef}
              value={draft}
              placeholder={placeholder}
              rows={1}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
          </div>
          <div class="composer-actions">
            <label class="composer-plus" title="Файл">
              <IconPlus />
              <input type="file" multiple onChange={(e) => { const input = e.currentTarget; void addFiles(input.files).finally(() => { input.value = ""; }); }} />
            </label>
            <span class="composer-spacer" />
            <button
              type="button"
              class={`composer-mic${recording ? " recording" : ""}`}
              title="Удерживай для голосового ввода"
              onPointerDown={startVoice}
              onPointerUp={endVoice}
              onPointerCancel={endVoice}
            >
              <IconMic />
            </button>
            {draft.trim() || files.length ? (
              <button
                class="composer-send ready"
                type="submit"
                aria-label="Отправить"
                title={uploadsLeft > 0 ? "Дождитесь загрузки файлов" : "Отправить"}
                disabled={uploadsLeft > 0 || sending}
              >
                <IconArrowUp />
              </button>
            ) : (
              <button
                class={`composer-send live${liveMode ? " on" : ""}`}
                type="button"
                aria-label="Live-разговор с агентом"
                title="Live-разговор с агентом"
                disabled={uploadsLeft > 0 || sending}
                onClick={() => { setLiveMode((v) => !v); setVoiceHint((cur) => liveMode ? "" : "Live-разговор с агентом появится позже"); }}
              >
                <IconWave />
              </button>
            )}
          </div>
        </div>
        {(recording || voiceHint || liveMode) && (
          <div class={`composer-hint${recording ? " rec" : ""}`}>
            {recording ? "● Запись… отпусти, чтобы вставить текст" : voiceHint || (liveMode ? "Live-режим: заглушка, разговор ещё не подключён" : "")}
          </div>
        )}
      </form>
      {error && <p class="error">{error}</p>}
    </section>
    {studio && studioTab && info?.projectId && (
      <div class="studio-pane">
        <PluginTab key={info.projectId} tab={studioTab} projectId={info.projectId} />
      </div>
    )}
    </>
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
