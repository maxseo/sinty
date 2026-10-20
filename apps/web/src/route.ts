import { useEffect, useState } from "preact/hooks";

export type Route =
  | { page: "chat"; sessionId?: string }
  | { page: "board" }
  | { page: "pending" }
  | { page: "supervisor" }
  | { page: "plugins" }
  | { page: "agents"; agentId?: string }
  | { page: "settings"; section: "general" | "models" | "plugins" }
  | { page: "kit" }
  | { page: "tab"; plugin: string; tab: string };

export function parse(hash: string): Route {
  const [, page = "", id, sub] = hash.replace(/^#/, "").split("/");
  switch (page) {
    case "s":
      return id ? { page: "chat", sessionId: decodeURIComponent(id) } : { page: "chat" };
    case "board":
    case "pending":
    case "supervisor":
    case "plugins":
      return { page };
    case "agents":
      return { page: "agents", ...(id ? { agentId: decodeURIComponent(id) } : {}) };
    case "kit":
      return { page };
    case "t":
      return id && sub ? { page: "tab", plugin: decodeURIComponent(id), tab: decodeURIComponent(sub) } : { page: "chat" };
    case "settings":
      return { page: "settings", section: id === "models" || id === "plugins" ? id : "general" };
    default:
      return { page: "chat" };
  }
}

export function href(r: Route): string {
  if (r.page === "chat") return r.sessionId ? `#/s/${encodeURIComponent(r.sessionId)}` : "#/";
  if (r.page === "settings") return `#/settings/${r.section}`;
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
