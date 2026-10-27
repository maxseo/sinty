import { useEffect, useState } from "preact/hooks";

export type Route =
  | { page: "chat"; sessionId?: string }
  | { page: "board" }
  | { page: "plugins" }
  | { page: "agents"; agentId?: string }
  /** `general`, `models`, `plugins`, or a settings section id from /v1/settings/sections (`supervisor`, `policy`, `memory`, `plugin.<name>`). */
  | { page: "settings"; section: string }
  | { page: "calendar" }
  | { page: "tab"; plugin: string; tab: string };

export function parse(hash: string): Route {
  const [, page = "", id, sub] = hash.replace(/^#/, "").split("/");
  switch (page) {
    case "s":
      return id ? { page: "chat", sessionId: decodeURIComponent(id) } : { page: "chat" };
    // The global «Журнал» (#/pending) and «Супервизор» (#/supervisor) pages are now chat-header tabs; old links open the chat list.
    case "board":
    case "plugins":
    case "calendar":
      return { page };
    case "agents":
      return { page: "agents", ...(id ? { agentId: decodeURIComponent(id) } : {}) };
    case "kit":
      return { page: "settings", section: "uikit" };
    case "t":
      return id && sub ? { page: "tab", plugin: decodeURIComponent(id), tab: decodeURIComponent(sub) } : { page: "chat" };
    case "settings":
      return { page: "settings", section: id && /^[a-z][a-z0-9.-]{0,80}$/.test(decodeURIComponent(id)) ? decodeURIComponent(id) : "general" };
    default:
      return { page: "chat" };
  }
}

export function href(r: Route): string {
  if (r.page === "chat") return r.sessionId ? `#/s/${encodeURIComponent(r.sessionId)}` : "#/";
  if (r.page === "settings") return `#/settings/${encodeURIComponent(r.section)}`;
  if (r.page === "tab") return `#/t/${encodeURIComponent(r.plugin)}/${encodeURIComponent(r.tab)}`;
  if (r.page === "agents") return r.agentId ? `#/agents/${encodeURIComponent(r.agentId)}` : "#/agents";
  return `#/${r.page}`;
}

export function go(r: Route): void {
  location.hash = href(r);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = (): void => setRoute(parse(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}
