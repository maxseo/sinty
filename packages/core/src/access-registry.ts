import type { PluginManifest } from "@sinty/sdk";
import type { AccessAction } from "./accounts.js";
import { NAV_RESOURCES } from "./accounts.js";
import type { RouteInfo } from "./host/protocol.js";

/** One row in Права. `placement` tells the combined checks of docs/spec/plugin-rules.md 5.4. */
export interface AccessItem {
  id: string;
  title: string;
  placement?: "sidebar" | "session" | "project" | "settings";
}

export interface AccessGroup {
  id: string;
  title: string;
  items: AccessItem[];
}

export interface RegistryPlugin {
  name: string;
  disabled: boolean;
  manifest: PluginManifest;
}

/** Core settings items that are not sections of `settings-sections.ts`. */
const CORE_SETTINGS: AccessItem[] = [
  { id: "settings:general", title: "Основные", placement: "settings" },
  { id: "settings:models", title: "Модели", placement: "settings" },
  { id: "settings:uikit", title: "UI Kit", placement: "settings" },
];

export const tabResource = (plugin: string, tabId: string): string => `ui:${plugin}/${tabId}`;
export const pluginSettingsResource = (plugin: string): string => `ui:${plugin}/settings`;

/** `supervisor` → `settings:supervisor`; `plugin.skills` → `ui:skills/settings`. */
export function sectionResource(sectionId: string): string {
  return sectionId.startsWith("plugin.") ? pluginSettingsResource(sectionId.slice(7)) : `settings:${sectionId}`;
}

/** Rights of the plugin's screens, in manifest order. A disabled plugin has none. */
export function pluginSurfaces(p: RegistryPlugin): AccessItem[] {
  if (p.disabled) return [];
  const tabs = (p.manifest.ui?.tabs ?? []).map((t) => ({ id: tabResource(p.name, t.id), title: t.title, placement: t.placement ?? ("sidebar" as const) }));
  const settings = p.manifest.settings ? [{ id: pluginSettingsResource(p.name), title: `${p.manifest.settings.title} · настройки`, placement: "settings" as const }] : [];
  return [...tabs, ...settings];
}

/**
 * Everything a role can be granted on this install right now: core panel, core settings, each running plugin's
 * screens, each project. Built on every request, so installing or disabling a plugin changes it at once.
 */
export function accessRegistry(input: {
  plugins: RegistryPlugin[];
  coreSections: { id: string; title: string }[];
  projects: { id: string; name: string }[];
}): AccessGroup[] {
  const groups: AccessGroup[] = [
    { id: "panel", title: "Панель", items: NAV_RESOURCES.map((n) => ({ id: n.id, title: n.title, placement: "sidebar" as const })) },
    {
      id: "settings",
      title: "Настройки",
      items: [...CORE_SETTINGS, ...input.coreSections.map((s) => ({ id: `settings:${s.id}`, title: s.title, placement: "settings" as const }))],
    },
  ];
  for (const p of [...input.plugins].sort((a, b) => a.name.localeCompare(b.name))) {
    const items = pluginSurfaces(p);
    if (items.length) groups.push({ id: `plugin:${p.name}`, title: p.name, items });
  }
  groups.push({ id: "projects", title: "Проекты", items: input.projects.map((x) => ({ id: `project:${x.id}`, title: x.name })) });
  return groups;
}

export const registryIds = (groups: AccessGroup[]): string[] => groups.flatMap((g) => g.items.map((i) => i.id));

/**
 * Which right a person needs for a plugin route: the route's `surface`, else the first tab, else settings.
 * `undefined` means the plugin has no screen for this route and people may not call it.
 */
export function routeRight(p: RegistryPlugin, route: RouteInfo, method: string): { resource: string; action: AccessAction; placement: AccessItem["placement"] } | undefined {
  const tabs = p.manifest.ui?.tabs ?? [];
  const surface = route.surface ?? tabs[0]?.id ?? (p.manifest.settings ? "settings" : undefined);
  if (!surface) return undefined;
  const action: AccessAction =
    route.access ?? (method === "GET" || method === "HEAD" ? "view" : method === "DELETE" ? "delete" : method === "POST" ? "add" : "edit");
  if (surface === "settings") return p.manifest.settings ? { resource: pluginSettingsResource(p.name), action, placement: "settings" } : undefined;
  const tab = tabs.find((t) => t.id === surface);
  return tab ? { resource: tabResource(p.name, tab.id), action, placement: tab.placement ?? "sidebar" } : undefined;
}
