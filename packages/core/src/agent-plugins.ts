import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginManifest } from "@sinty/sdk";
import type { SintyPaths } from "./paths.js";

/**
 * Plugins the agent wrote itself (plugin.create). They get a narrower rule set than plugins a human installs,
 * see docs/spec/plugin-rules.md section 9. The list lives outside every plugin folder, so no patch can edit it.
 */
const REGISTRY = ".agent-made.json";

export const AGENT_KINDS: ReadonlySet<string> = new Set(["tool", "ui", "schedule", "event"]);

export function agentMadePlugins(paths: SintyPaths): Set<string> {
  const file = join(paths.plugins, REGISTRY);
  if (!existsSync(file)) return new Set();
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    // Unreadable list: treat every home plugin as unknown, not as agent-made with fewer rules.
    return new Set();
  }
}

export function markAgentMade(paths: SintyPaths, name: string, on: boolean): void {
  const names = agentMadePlugins(paths);
  if (on) names.add(name);
  else names.delete(name);
  mkdirSync(paths.plugins, { recursive: true });
  writeFileSync(join(paths.plugins, REGISTRY), `${JSON.stringify([...names].sort(), null, 2)}\n`);
}

const DATA_PATH = /^\$DATA(\/[A-Za-z0-9_.\-/]*)?$/;
const PLUGIN_PATH = /^\$PLUGIN(\/[A-Za-z0-9_.\-/]*)?$/;

/** What the manifest of an agent-made plugin may not ask for. Empty when it is within the rules. */
export function agentManifestViolations(m: PluginManifest): string[] {
  const out: string[] = [];
  const p = m.permissions;
  if (m.runtime !== "node") out.push(`runtime must be "node" (MCP servers go through mcp.install)`);
  if (!m.entry || !/\.(ts|mjs|js)$/.test(m.entry)) out.push("entry must be a .ts, .mjs or .js file of the plugin");
  for (const k of m.kinds) if (!AGENT_KINDS.has(k)) out.push(`kind "${k}" is not allowed; use ${[...AGENT_KINDS].join(", ")}`);
  if (m.editable === false) out.push("editable: false is not allowed");
  if (p.shell) out.push("permissions.shell is not allowed");
  if (p.browser) out.push("permissions.browser is not allowed");
  if (p.context?.length) out.push("permissions.context is not allowed");
  if (p.env?.length) out.push("permissions.env is not allowed; read secrets by name through permissions.secrets");
  if (p.agent?.includes("sessions.write")) out.push('permissions.agent "sessions.write" is not allowed');
  for (const g of p.fs?.write ?? []) if (!DATA_PATH.test(g) || g.includes("..")) out.push(`fs.write "${g}": only $DATA or a folder inside it`);
  for (const g of p.fs?.read ?? []) if ((!DATA_PATH.test(g) && !PLUGIN_PATH.test(g)) || g.includes("..")) out.push(`fs.read "${g}": only $DATA or $PLUGIN`);
  if (m.ui?.static) out.push("ui.static is not allowed; show pages through ui.tabs with path");
  for (const t of m.ui?.tabs ?? []) if (t.builtin) out.push(`ui.tabs "${t.id}": builtin pages belong to the core Web UI`);
  for (const t of m.tools ?? []) {
    if (!t.name.startsWith(`${m.name}.`)) out.push(`tool "${t.name}" must be named ${m.name}.<verb>`);
    if (t.defaultPolicy === "allow") out.push(`tool "${t.name}": defaultPolicy "allow" is not allowed; policy.yaml decides`);
  }
  return out;
}

/** What a running agent-made plugin may not register. Checked on every start, not only in the patch pipeline. */
export function agentRuntimeViolations(
  m: PluginManifest,
  reg: { tools: { name: string }[]; routes: { method: string; path: string; public: boolean }[]; providers: string[] },
): string[] {
  const out: string[] = [];
  for (const t of reg.tools) if (!t.name.startsWith(`${m.name}.`)) out.push(`tool "${t.name}" must be named ${m.name}.<verb>`);
  if (reg.providers.length) out.push("model providers are not allowed");
  const tabPaths = new Set((m.ui?.tabs ?? []).flatMap((t) => (t.path ? [t.path] : [])));
  for (const r of reg.routes) {
    if (r.public && !(r.method === "GET" && tabPaths.has(r.path))) out.push(`route ${r.method} ${r.path} may not be public; only the GET page of a ui.tabs entry is`);
  }
  return out;
}
