import { useEffect, useRef, useState } from "preact/hooks";
import { token, api } from "./api.js";
import { DYNAMIC_CATALOG_OP, catalogMessageAllowed, metadataOnly } from "./dynamic-catalog-bridge.js";

/** A tab a plugin declares in its manifest (`ui.tabs`), as listed by GET /v1/plugins. */
export interface PluginTabInfo {
  plugin: string;
  id: string;
  title: string;
  /** `/p/<plugin><path>`: a public route of the plugin that serves the static page. Absent for a `builtin` page. */
  src?: string;
  /** A page of this Web UI build (`board`, `calendar`) instead of an iframe. */
  builtin?: string;
  /** `sidebar`: own page in the left nav. `session`: a view toggle in the open chat's header. `project`: a tab inside a project. */
  placement: "sidebar" | "session" | "project" | "settings";
  /** Settings tab shown under Settings → Модели. */
  group?: "models";
}

/** Access right of a tab, as in docs/spec/plugin-rules.md. */
export const tabRight = (t: Pick<PluginTabInfo, "plugin" | "id">): string => `ui:${t.plugin}/${t.id}`;

/** Key of a session tab among the chat views ("chat", "journal", "tab:<plugin>/<id>"). */
export const tabViewKey = (t: Pick<PluginTabInfo, "plugin" | "id">): string => `tab:${t.plugin}/${t.id}`;

const PROTO = "tab/1";
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_POST = 256 * 1024;
const MAX_IN_FLIGHT = 8;

/**
 * Plugin pages run in `<iframe sandbox="allow-scripts">`: an opaque origin, so they cannot read the token,
 * call the API, or touch this page. The Diffusion editor is the exception (`allow-same-origin`): its scripts
 * and storage have to live in the frame, and the film form needs `allow-forms`. Other tabs stay opaque. They ask for data with postMessage
 * `{ sinty: "tab/1", id, op: "get"|"post", path, body? }`. The bridge forwards only to the same plugin's own
 * routes (`/p/<plugin><path>`), adds the token, and returns JSON. `post` sends a JSON object. Nothing else of the API is reachable from a tab.
 * A session tab is also told which chat is open: `init.sessionId`, then `{ op: "session", sessionId }` on every switch.
 */
export function safeTabPath(path: unknown): string | undefined {
  if (typeof path !== "string" || path.length > 2000 || !path.startsWith("/") || path.startsWith("//")) return undefined;
  if (!/^\/[A-Za-z0-9_\-./%]*(\?[A-Za-z0-9_\-.%=&+~]*)?$/.test(path)) return undefined;
  const pathname = path.split("?")[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\\") || [...pathname.split("/"), ...decoded.split("/")].some((seg) => seg === ".." || seg === ".")) return undefined;
  return path;
}

export function PluginTab({ tab, sessionId, projectId }: { tab: PluginTabInfo; sessionId?: string; projectId?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState("");
  const session = useRef(sessionId);
  const ready = useRef(false);

  useEffect(() => {
    let inFlight = 0;
    let closed = false;
    const uploads = new Map<number, AbortController>();
    const catalogNonce = crypto.randomUUID();
    const reply = (msg: Record<string, unknown>): void => frame.current?.contentWindow?.postMessage({ sinty: PROTO, ...msg }, "*");
    const onMessage = (e: MessageEvent): void => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      const m = e.data as { sinty?: string; id?: unknown; op?: string; path?: unknown; body?: unknown; nonce?: unknown; filename?: unknown; file?: unknown; loaded?: unknown; total?: unknown } | null;
      if (!m || m.sinty !== PROTO) return;
      if (m.op === "ready") {
        ready.current = true;
        reply({ op: "init", ...(tab.plugin === "dynamic-tools" && tab.id === "settings" ? { catalogNonce } : {}), plugin: tab.plugin, tab: tab.id, theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light", ...(session.current ? { sessionId: session.current } : {}), ...(projectId ? { projectId } : {}) });
        return;
      }

      if (m.op === DYNAMIC_CATALOG_OP) {
        if (typeof m.id !== 'number') return;
        if (!catalogMessageAllowed(tab.plugin, tab.id, e.source, win, e.origin, m.nonce, catalogNonce) || ['path','body','url','method','query','projectId','agentId','sessionId'].some(key => key in m)) {
          reply({ id: m.id, ok: false, error: { code: 'catalog_denied', message: 'Read-only metadata capability unavailable' } }); return;
        }
        if (inFlight >= MAX_IN_FLIGHT) { reply({ id: m.id, ok: false, error: { code: 'busy', message: 'Too many requests' } }); return; }
        inFlight++;
        void Promise.all([api<unknown>('/v1/agent'), api<unknown>('/v1/plugins')]).then(([agent, plugins]) => {
          if (!closed && frame.current?.contentWindow === win) reply({ id: m.id, ok: true, data: { tools: metadataOnly(agent, plugins), registryOnly: true } });
        }).catch(() => { if (!closed) reply({ id: m.id, ok: false, error: { code: 'catalog_unavailable', message: 'Registry metadata unavailable for this account' } }); }).finally(() => { inFlight--; });
        return;
      }

      if (m.op === "upload-cancel" && typeof m.id === "number") {
        uploads.get(m.id)?.abort();
        uploads.delete(m.id);
        return;
      }
      if (m.op === "upload") {
        if (typeof m.id !== "number") return;
        const id = m.id;
        const filename = typeof m.filename === "string" ? m.filename : "";
        const file = (m as { file?: unknown }).file;
        if (!(file instanceof Blob)) {
          reply({ id, ok: false, error: { code: "bad_file", message: "нужен файл" } });
          return;
        }
        if (inFlight >= MAX_IN_FLIGHT) {
          reply({ id, ok: false, error: { code: "busy", message: "too many requests in flight" } });
          return;
        }
        const ac = new AbortController();
        uploads.set(id, ac);
        inFlight++;
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `/v1/plugin-data/${encodeURIComponent(tab.plugin)}/uploads?filename=${encodeURIComponent(filename)}`);
        xhr.setRequestHeader("authorization", `Bearer ${token.get()}`);
        xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
        xhr.setRequestHeader("x-sinty-filename", filename);
        xhr.responseType = "text";
        xhr.upload.onprogress = (ev) => {
          if (closed || frame.current?.contentWindow !== win) return;
          reply({ op: "upload-progress", id, loaded: ev.loaded, total: ev.total || file.size });
        };
        xhr.onerror = () => {
          inFlight--;
          uploads.delete(id);
          if (!closed) reply({ id, ok: false, error: { code: "bridge_error", message: "upload failed" } });
        };
        xhr.onabort = () => {
          inFlight--;
          uploads.delete(id);
          if (!closed) reply({ id, ok: false, error: { code: "cancelled", message: "загрузка отменена" } });
        };
        xhr.onload = () => {
          inFlight--;
          uploads.delete(id);
          if (closed) return;
          try {
            const data = JSON.parse(xhr.responseText || "{}");
            if (xhr.status >= 200 && xhr.status < 300) reply({ id, ok: true, data: { ...data, uploadId: data.id } });
            else {
              const err = data.error || {};
              reply({ id, ok: false, error: { code: err.code ?? `http_${xhr.status}`, message: err.message ?? xhr.statusText } });
            }
          } catch (err) {
            reply({ id, ok: false, error: { code: "bridge_error", message: err instanceof Error ? err.message : String(err) } });
          }
        };
        ac.signal.addEventListener("abort", () => xhr.abort(), { once: true });
        xhr.send(file);
        return;
      }
      if (m.op === "catalog-bind" || m.op === "catalog-unbind") {
        if (typeof m.id !== "number") return;
        const id = m.id;
        if (tab.group !== "models") {
          reply({ id, ok: false, error: { code: "catalog_denied", message: "привязка каталога доступна только вкладкам группы Модели" } });
          return;
        }
        const body = m.body && typeof m.body === "object" && !Array.isArray(m.body) ? m.body : null;
        if (!body) {
          reply({ id, ok: false, error: { code: "bad_body", message: "нужен объект" } });
          return;
        }
        if (inFlight >= MAX_IN_FLIGHT) {
          reply({ id, ok: false, error: { code: "busy", message: "too many requests in flight" } });
          return;
        }
        inFlight++;
        const method = m.op === "catalog-bind" ? "POST" : "DELETE";
        void fetch("/v1/models/bindings", {
          method,
          headers: { authorization: `Bearer ${token.get()}`, accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(body),
          credentials: "omit",
          redirect: "error",
        }).then(async (res) => {
          const data = await res.json();
          if (!res.ok) {
            const err = data.error || {};
            if (!closed) reply({ id, ok: false, error: { code: err.code ?? `http_${res.status}`, message: err.message ?? res.statusText } });
          } else if (!closed) reply({ id, ok: true, data });
        }).catch((err) => {
          if (!closed) reply({ id, ok: false, error: { code: "bridge_error", message: err instanceof Error ? err.message : String(err) } });
        }).finally(() => { inFlight--; });
        return;
      }
      if ((m.op !== "get" && m.op !== "post") || typeof m.id !== "number") return;
      const id = m.id;
      const path = safeTabPath(m.path);
      if (!path) return reply({ id, ok: false, error: { code: "bad_path", message: "only routes of this plugin, like /items?x=1" } });
      let posted = "";
      if (m.op === "post") {
        if (!m.body || typeof m.body !== "object" || Array.isArray(m.body)) return reply({ id, ok: false, error: { code: "bad_body", message: "post body must be a JSON object" } });
        posted = JSON.stringify(m.body);
        if (posted.length > MAX_POST) return reply({ id, ok: false, error: { code: "too_large", message: "post body is too large" } });
      }
      if (inFlight >= MAX_IN_FLIGHT) return reply({ id, ok: false, error: { code: "busy", message: "too many requests in flight" } });
      inFlight++;
      const method = m.op === "post" ? "POST" : "GET";
      void (async () => {
        try {
          const res = await fetch(`/p/${encodeURIComponent(tab.plugin)}${path}`, {
            method,
            headers: { authorization: `Bearer ${token.get()}`, accept: "application/json", ...(posted ? { "content-type": "application/json" } : {}) },
            ...(posted ? { body: posted } : {}),
            credentials: "omit",
            redirect: "error",
          });
          const type = res.headers.get("content-type") ?? "";
          if (!type.includes("application/json")) throw new Error(`not JSON (${res.status})`);
          const text = await res.text();
          if (text.length > MAX_BYTES) throw new Error("response too large");
          const data: unknown = JSON.parse(text);
          if (!res.ok) {
            const err = (data as { error?: { code?: string; message?: string } }).error;
            reply({ id, ok: false, error: { code: err?.code ?? `http_${res.status}`, message: err?.message ?? res.statusText } });
          } else reply({ id, ok: true, data });
        } catch (err) {
          reply({ id, ok: false, error: { code: "bridge_error", message: err instanceof Error ? err.message : String(err) } });
        } finally {
          inFlight--;
        }
      })();
    };
    addEventListener("message", onMessage);
    return () => { closed = true; removeEventListener("message", onMessage); for (const ac of uploads.values()) ac.abort(); uploads.clear(); };
  }, [tab.plugin, tab.id]);

  useEffect(() => {
    const root = document.documentElement;
    const push = (): void => {
      const theme = root.dataset.theme === "dark" ? "dark" : "light";
      frame.current?.contentWindow?.postMessage({ sinty: PROTO, op: "theme", theme }, "*");
    };
    const obs = new MutationObserver(push);
    obs.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, [tab.src]);

  // The chat switched: tell the page instead of reloading it.
  useEffect(() => {
    if (session.current === sessionId) return;
    session.current = sessionId;
    if (ready.current) frame.current?.contentWindow?.postMessage({ sinty: PROTO, op: "session", ...(sessionId ? { sessionId } : {}) }, "*");
  }, [sessionId]);

  useEffect(() => setError(tab.src && safeTabPath(tab.src.replace(/^\/p\/[^/]+/, "")) ? "" : "bad tab path"), [tab.src]);

  return (
    <div class="plugin-tab">
      {error || !tab.src ? (
        <p class="error">{error || "bad tab path"}</p>
      ) : (
        <iframe ref={frame} key={tab.src} title={tab.title} src={tab.src} sandbox={tab.plugin === "diffusion" ? "allow-scripts allow-same-origin allow-forms" : "allow-scripts"} referrerpolicy="no-referrer" allow={tab.plugin === "diffusion" ? "fullscreen; clipboard-read; clipboard-write" : ""} />
      )}
    </div>
  );
}
