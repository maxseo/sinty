export interface Actor {
  kind: string;
  id: string;
}

export interface SintyEvent {
  id?: string;
  seq?: number;
  ts: string;
  sessionId: string;
  turnId?: string;
  type: string;
  actor?: Actor;
  data: Record<string, unknown>;
}

export interface SessionInfo {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  projectId?: string | null;
  metadata: Record<string, unknown>;
  activeTurn: { id: string; status: "running" | "blocked" } | null;
}

export interface Pending {
  sessionId: string;
  turnId: string;
  reason: "approval" | "ask_human" | "supervisor" | "budget";
  detail?: string;
  approvals: { callId: string; tool: string; args: unknown; reason: string }[];
  askCallId?: string;
}

const TOKEN_KEY = "sinty.token";

/** `#token=…` from `sinty web` is moved to localStorage and removed from the address bar. */
export function takeTokenFromUrl(): void {
  const m = /^#token=([^&]+)/.exec(location.hash);
  if (!m) return;
  localStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]!));
  history.replaceState(null, "", `${location.pathname}${location.search}#/`);
}

export const token = {
  get: (): string => localStorage.getItem(TOKEN_KEY) ?? "",
  set: (t: string): void => localStorage.setItem(TOKEN_KEY, t),
  clear: (): void => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token.get()}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  if (res.status === 401) onUnauthorized();
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  if (!res.ok) throw new ApiError(res.status, body.error?.code ?? `http_${res.status}`, body.error?.message ?? res.statusText);
  return body as T;
}

/**
 * Asks the server for a new login token and keeps it in this tab. The old token stops working everywhere at once:
 * other tabs and devices get the sign-in screen on their next request.
 */
export async function rotateToken(): Promise<void> {
  const res = await api<{ token: string }>("/v1/auth/rotate", { method: "POST" });
  token.set(res.token);
}

export interface SSEMessage {
  event: string;
  data: string;
  id?: string;
}

/**
 * Reads an SSE endpoint with the bearer header (EventSource cannot send headers)
 * and reconnects with backoff; `path(lastId)` builds the URL to resume from.
 */
export function subscribe(path: (lastId: string | undefined) => string, onMessage: (m: SSEMessage) => void, onStatus?: (live: boolean) => void): () => void {
  const ctl = new AbortController();
  let lastId: string | undefined;
  let delay = 500;
  void (async () => {
    while (!ctl.signal.aborted) {
      try {
        const res = await fetch(path(lastId), { headers: { authorization: `Bearer ${token.get()}`, accept: "text/event-stream" }, signal: ctl.signal });
        if (res.status === 401) {
          onUnauthorized();
          return;
        }
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        onStatus?.(true);
        delay = 500;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let cut: number;
          while ((cut = buf.search(/\r?\n\r?\n/)) >= 0) {
            const block = buf.slice(0, cut);
            buf = buf.slice(cut).replace(/^\r?\n\r?\n/, "");
            const m: SSEMessage = { event: "message", data: "" };
            const data: string[] = [];
            for (const line of block.split(/\r?\n/)) {
              if (!line || line.startsWith(":")) continue;
              const i = line.indexOf(":");
              const field = i < 0 ? line : line.slice(0, i);
              const val = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
              if (field === "data") data.push(val);
              else if (field === "event") m.event = val;
              else if (field === "id") m.id = val;
            }
            if (!data.length) continue;
            m.data = data.join("\n");
            if (m.id) lastId = m.id;
            if (m.event !== "ping" && m.event !== "auth.revoked") onMessage(m);
          }
        }
      } catch {
        if (ctl.signal.aborted) return;
      }
      onStatus?.(false);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 10_000);
    }
  })();
  return () => ctl.abort();
}

export function shortTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { day: "2-digit", month: "short" });
}
