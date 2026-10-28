import { createContext } from "preact";
import { useContext } from "preact/hooks";

export type AccessAction = "view" | "add" | "edit" | "delete";

export interface Me {
  kind: "machine" | "user";
  superadmin: boolean;
  user?: { id: string; roleId: string; firstName: string; lastName: string; email: string };
  can: Record<string, { view: boolean; add: boolean; edit: boolean; delete: boolean }>;
}

/** Until /v1/auth/me answers, nothing role-gated is shown. */
export const AccessContext = createContext<Me | undefined>(undefined);

export function useAccess(): { me: Me | undefined; can: (resource: string, action?: AccessAction) => boolean } {
  const me = useContext(AccessContext);
  return { me, can: (resource, action = "view") => Boolean(me?.can[resource]?.[action]) };
}

/** First settings section this person may open; the gear button lands there. */
export function firstSection(can: (resource: string) => boolean): string {
  if (can("settings:general")) return "general";
  if (can("settings:models")) return "models";
  if (can("nav:plugins")) return "plugins";
  if (can("nav:staff")) return "staff";
  return "uikit";
}
