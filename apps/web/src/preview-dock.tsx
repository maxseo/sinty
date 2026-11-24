import { useEffect, useState } from "preact/hooks";
import { token } from "./api.js";
import { IconClose, IconPanelRight, IconPlus } from "./icons.js";
import { Markdown } from "./markdown.js";
import { PluginTab, type PluginTabInfo } from "./plugin-tab.js";

export interface PanePreview {
  title: string;
  path?: string;
  url?: string;
  text?: string;
  mime?: string;
}

export interface BrowserTab extends PanePreview {
  id: string;
  kind: "browser";
  /** Chat that may load a project media path. */
  sessionId?: string;
}

let keptTabs: BrowserTab[] = [];
let keptActive = "video";

export function keptPreview(): { tabs: BrowserTab[]; active: string } {
  return { tabs: keptTabs, active: keptActive };
}

export function keepPreview(tabs: BrowserTab[], active: string): void {
  keptTabs = tabs;
  keptActive = active;
}

export function previewFromResult(result: unknown): PanePreview | undefined {
  if (!result || typeof result !== "object") return;
  const raw = (result as { preview?: unknown }).preview;
  if (!raw || typeof raw !== "object") return;
  const row = raw as Record<string, unknown>;
  const title = typeof row.title === "string" && row.title.trim() ? row.title.trim().slice(0, 80) : "Просмотр";
  const path = typeof row.path === "string" && row.path.trim() ? row.path.trim() : undefined;
  const url = typeof row.url === "string" && (/^https?:\/\//i.test(row.url) || row.url.startsWith("/p/tool-fs/raw/")) ? row.url : undefined;
  const text = typeof row.text === "string" ? row.text : undefined;
  const mime = typeof row.mime === "string" ? row.mime : undefined;
  if (!path && !url && text === undefined) return;
  return { title, ...(path ? { path } : {}), ...(url ? { url } : {}), ...(text !== undefined ? { text } : {}), ...(mime ? { mime } : {}) };
}

export function PreviewDock({
  tabs,
  active,
  sessionId,
  projectId,
  studioTab,
  onActive,
  onClose,
  onAdd,
  onNavigate,
  onCollapse,
}: {
  tabs: BrowserTab[];
  active: string;
  sessionId: string;
  projectId?: string;
  studioTab: PluginTabInfo | null;
  onActive: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  onNavigate: (id: string, target: string) => void;
  onCollapse: () => void;
}) {
  const video = active === "video";
  const tab = tabs.find((t) => t.id === active);
  return (
    <div class="preview">
      <header class="dock-bar">
        <div class="dock-tabs" role="tablist">
          {studioTab && projectId && (
            <div class={`dock-tab${video ? " on" : ""}`}>
              <button type="button" role="tab" aria-selected={video} onClick={() => onActive("video")}>Видео</button>
              <button type="button" class="dock-x" aria-label="Закрыть Видео" onClick={() => onClose("video")}><IconClose /></button>
            </div>
          )}
          {tabs.map((t) => (
            <div key={t.id} class={`dock-tab${t.id === active ? " on" : ""}`}>
              <button type="button" role="tab" aria-selected={t.id === active} title={t.title} onClick={() => onActive(t.id)}>{t.title}</button>
              <button type="button" class="dock-x" aria-label={`Закрыть ${t.title}`} onClick={() => onClose(t.id)}><IconClose /></button>
            </div>
          ))}
          <button type="button" class="dock-add" title="Новая вкладка браузера" onClick={onAdd}><IconPlus /></button>
        </div>
        <button type="button" class="icon" title="Свернуть правую панель" onClick={onCollapse}><IconPanelRight /></button>
      </header>
      <div class="dock-body">
        {video && studioTab && projectId && <PluginTab key={projectId} tab={studioTab} projectId={projectId} />}
        {tab && <BrowserView key={tab.id} sessionId={sessionId} tab={tab} onNavigate={(target) => onNavigate(tab.id, target)} />}
      </div>
    </div>
  );
}

function BrowserView({ sessionId, tab, onNavigate }: { sessionId: string; tab: BrowserTab; onNavigate: (target: string) => void }) {
  const [draft, setDraft] = useState(tab.url || tab.path || "");
  const [src, setSrc] = useState("");
  const [kind, setKind] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => { setDraft(tab.url || tab.path || ""); }, [tab.url, tab.path]);
  useEffect(() => {
    if (tab.url || tab.mime !== "media" || !tab.path) return;
    let dead = false;
    let blob = "";
    setErr("");
    setSrc("");
    void fetch(`/v1/sessions/${encodeURIComponent(tab.sessionId || sessionId)}/media?path=${encodeURIComponent(tab.path)}`, {
      headers: { authorization: `Bearer ${token.get()}` },
    }).then(async (res) => {
      if (!res.ok) throw new Error("Файл не открывается по этому пути");
      const body = await res.blob();
      blob = URL.createObjectURL(body);
      if (dead) { URL.revokeObjectURL(blob); return; }
      setKind(body.type);
      setSrc(blob);
    }).catch((e: unknown) => { if (!dead) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { dead = true; if (blob) URL.revokeObjectURL(blob); };
  }, [sessionId, tab.sessionId, tab.path, tab.url, tab.mime]);
  useEffect(() => {
    if (tab.mime !== "application/pdf" || !tab.text) return;
    let blob = "";
    try {
      const bytes = Uint8Array.from(atob(tab.text), (c) => c.charCodeAt(0));
      blob = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      setSrc(blob);
    } catch {
      setErr("PDF не прочитался");
    }
    return () => { if (blob) URL.revokeObjectURL(blob); };
  }, [tab.mime, tab.text]);
  const go = (e: Event) => {
    e.preventDefault();
    const target = draft.trim();
    if (target) onNavigate(target);
  };
  return (
    <div class="dock-browser">
      <form class="dock-nav" onSubmit={go}>
        <input value={draft} placeholder="https://… или путь к картинке, видео, звуку" onInput={(e) => setDraft(e.currentTarget.value)} />
        <button type="submit">Открыть</button>
      </form>
      <div class="dock-frame">
        {tab.url && <iframe title={tab.title} sandbox="allow-scripts allow-forms allow-popups" referrerPolicy="no-referrer" src={tab.url} />}
        {!tab.url && tab.mime === "text/html" && tab.text !== undefined && <iframe title={tab.title} sandbox="allow-scripts" srcDoc={tab.text} />}
        {!tab.url && tab.mime === "text/markdown" && tab.text !== undefined && <div class="dock-read"><Markdown text={tab.text} /></div>}
        {!tab.url && tab.mime === "text/plain" && tab.text !== undefined && <pre class="dock-read">{tab.text}</pre>}
        {!tab.url && tab.mime === "image/svg+xml" && tab.text !== undefined && <img alt={tab.title} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(tab.text)}`} />}
        {!tab.url && tab.mime === "application/pdf" && src && <iframe title={tab.title} src={src} />}
        {!tab.url && tab.mime === "media" && src && kind.startsWith("video/") && <video src={src} controls />}
        {!tab.url && tab.mime === "media" && src && kind.startsWith("audio/") && <audio src={src} controls />}
        {!tab.url && tab.mime === "media" && src && !kind.startsWith("video/") && !kind.startsWith("audio/") && <img alt={tab.title} src={src} />}
        {err && <p class="error">{err}</p>}
        {!tab.url && !tab.path && tab.text === undefined && <p class="muted">Вставьте ссылку или путь. Агент открывает файл сюда через просмотр.</p>}
      </div>
    </div>
  );
}
