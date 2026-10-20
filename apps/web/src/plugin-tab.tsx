import { useEffect, useRef, useState } from "preact/hooks";
import { token } from "./api.js";

/** A tab a plugin declares in its manifest (`ui.tabs`), as listed by GET /v1/plugins. */
export interface PluginTabInfo {
  plugin: string;
  id: string;
  title: string;
  /** `/p/<plugin><path>`: a public route of the plugin that serves the static page. */
  src: string;
  /** `sidebar`: own page in the left nav. `session`: a view toggle in the open chat's header. */
  placement: "sidebar" | "session";
}

/** Key of a session tab among the chat views ("chat", "journal", "tab:<plugin>/<id>"). */
export const tabViewKey = (t: Pick<PluginTabInfo, "plugin" | "id">): string => `tab:${t.plugin}/${t.id}`;

const PROTO = "tab/1";
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_IN_FLIGHT = 8;

/**
 * Plugin pages run in `<iframe sandbox="allow-scripts">`: an opaque origin, so they cannot read the token in
 * localStorage, call the API, or touch this page. They ask for data with postMessage
 * `{ sinty: "tab/1", id, op: "get", path }`; the bridge only forwards GET requests to the same plugin's own routes
 * (`/p/<plugin><path>`), adds the token, and returns JSON. Nothing else of the API is reachable from a tab.
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

export function PluginTab({ tab, sessionId }: { tab: PluginTabInfo; sessionId?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState("");
  const session = useRef(sessionId);
  const ready = useRef(false);

  useEffect(() => {
    let inFlight = 0;
    const reply = (msg: Record<string, unknown>): void => frame.current?.contentWindow?.postMessage({ sinty: PROTO, ...msg }, "*");
    const onMessage = (e: MessageEvent): void => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      const m = e.data as { sinty?: string; id?: unknown; op?: string; path?: unknown } | null;
      if (!m || m.sinty !== PROTO) return;
      if (m.op === "ready") {
        ready.current = true;
        reply({ op: "init", plugin: tab.plugin, tab: tab.id, theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light", ...(session.current ? { sessionId: session.current } : {}) });
        return;
      }
      if (m.op !== "get" || typeof m.id !== "number") return;
      const id = m.id;
      const path = safeTabPath(m.path);
      if (!path) return reply({ id, ok: false, error: { code: "bad_path", message: "only GET routes of this plugin, like /items?x=1" } });
      if (inFlight >= MAX_IN_FLIGHT) return reply({ id, ok: false, error: { code: "busy", message: "too many requests in flight" } });
      inFlight++;
      void (async () => {
        try {
          const res = await fetch(`/p/${encodeURIComponent(tab.plugin)}${path}`, { headers: { authorization: `Bearer ${token.get()}`, accept: "application/json" }, credentials: "omit", redirect: "error" });
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
    return () => removeEventListener("message", onMessage);
  }, [tab.plugin, tab.id]);

  // The chat switched: tell the page instead of reloading it.
  useEffect(() => {
    if (session.current === sessionId) return;
    session.current = sessionId;
    if (ready.current) frame.current?.contentWindow?.postMessage({ sinty: PROTO, op: "session", ...(sessionId ? { sessionId } : {}) }, "*");
  }, [sessionId]);

  useEffect(() => setError(safeTabPath(tab.src.replace(/^\/p\/[^/]+/, "")) ? "" : "bad tab path"), [tab.src]);

  return (
    <div class="plugin-tab">
      {error ? (
        <p class="error">{error}</p>
      ) : (
        <iframe ref={frame} key={tab.src} title={tab.title} src={tab.src} sandbox="allow-scripts" referrerpolicy="no-referrer" allow="" />
      )}
    </div>
  );
}
