import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import type { SintyPaths } from "./paths.js";

const MODEL_ROUTE = /^[a-z0-9][a-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9._:+-]*$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]*$/;

export interface CatalogBindingInput {
  route: string;
  provider: { id: string; protocol?: string | undefined; baseUrl: string; apiKey?: string | undefined };
}

function loadDoc(paths: SintyPaths) {
  return parseDocument(existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "");
}

function catalogFromDoc(doc: ReturnType<typeof parseDocument>): { route: string; enabled: boolean }[] {
  const node = doc.getIn(["models", "catalog"]);
  const raw = node && typeof (node as { toJSON?: () => unknown }).toJSON === "function" ? (node as { toJSON: () => unknown }).toJSON() : node;
  if (!Array.isArray(raw)) return [];
  const out: { route: string; enabled: boolean }[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const route = typeof (row as { route?: unknown }).route === "string" ? (row as { route: string }).route.trim() : "";
    const enabled = (row as { enabled?: unknown }).enabled !== false;
    if (route && MODEL_ROUTE.test(route)) out.push({ route, enabled });
  }
  return out;
}

function protocolOf(value: unknown): "openai-compat" | "openai-responses" | "anthropic" {
  return value === "anthropic" || value === "openai-responses" ? value : "openai-compat";
}

/**
 * Adds or updates one catalog route and its provider. Never removes other routes, providers,
 * models.default, models.fallback or named routes.
 */
export function bindModelCatalogRoute(paths: SintyPaths, input: CatalogBindingInput, known: Record<string, { protocol?: string | undefined } | undefined>): { route: string; created: boolean } {
  const route = input.route.trim();
  if (!MODEL_ROUTE.test(route)) throw new Error(`model must look like provider/model-id, got ${route}`);
  const id = input.provider.id.trim();
  if (!PROVIDER_ID.test(id)) throw new Error(`bad provider id ${id}`);
  const prefix = route.slice(0, route.indexOf("/"));
  if (prefix !== id) throw new Error(`маршрут ${route} должен начинаться с ${id}/`);
  const baseUrl = input.provider.baseUrl.trim();
  if (!baseUrl) throw new Error("нужен адрес сервера");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("адрес сервера должен быть http(s)");
  const protocol = protocolOf(input.provider.protocol);
  const apiKey = input.provider.apiKey?.trim() ? `secret://${id}` : undefined;

  const doc = loadDoc(paths);
  const catalog = catalogFromDoc(doc);
  const existed = catalog.some((m) => m.route === route);
  if (!existed) catalog.push({ route, enabled: true });
  else {
    for (const row of catalog) if (row.route === route) row.enabled = true;
  }

  if (!known[id] && !doc.getIn(["providers", id])) {
    doc.setIn(["providers", id], { protocol, baseUrl, ...(apiKey ? { apiKey } : {}) });
  } else {
    doc.setIn(["providers", id, "baseUrl"], baseUrl);
    doc.setIn(["providers", id, "protocol"], protocol);
    if (apiKey) doc.setIn(["providers", id, "apiKey"], apiKey);
  }
  doc.setIn(["models", "catalog"], catalog);
  writeFileSync(paths.config, String(doc));
  return { route, created: !existed };
}

/** Removes only that catalog route. Leaves the provider and other models untouched. */
export function unbindModelCatalogRoute(paths: SintyPaths, routeRaw: string): { route: string; removed: boolean } {
  const route = routeRaw.trim();
  if (!MODEL_ROUTE.test(route)) throw new Error(`model must look like provider/model-id, got ${route}`);
  const doc = loadDoc(paths);
  const catalog = catalogFromDoc(doc);
  const next = catalog.filter((m) => m.route !== route);
  const removed = next.length !== catalog.length;
  if (removed) {
    doc.setIn(["models", "catalog"], next);
    writeFileSync(paths.config, String(doc));
  }
  return { route, removed };
}
