import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SintyPaths } from "./paths.js";

export interface AgentRecord {
  id: string;
  name: string;
  /** Short role title, shown on the card. */
  specialization: string;
  /** One-line description, shown on the card. */
  summary: string;
  /** Data URL or empty. */
  avatar: string;
  persona: string;
  /** Empty means the installation default model. */
  model: string;
  /** Empty means the installation fallback list. */
  fallback: string;
  serviceModel: string;
  compress: string;
  facts: string;
  /** null uses the installation stall threshold. */
  stallSeconds: number | null;
  skills: string[];
  /**
   * The optional plugins this agent gets (tools, MCP connectors). Empty means the shared list. Bundled default-on
   * plugins that replace former core tools (`DEFAULT_ON_PLUGINS`, e.g. tool-web) are not taken from this list.
   */
  plugins: string[];
  /** Default-on plugins this agent explicitly goes without. Only these can take a default-on plugin away from it. */
  excludedPlugins: string[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
  leadId: string;
  agentIds: string[];
}

interface RosterFile {
  agents: AgentRecord[];
  projects: ProjectRecord[];
  /** null until the human saves the list; then only these plugins are on every agent. */
  sharedPlugins: string[] | null;
}

const empty = (): RosterFile => ({ agents: [], projects: [], sharedPlugins: null });

function file(paths: SintyPaths): string {
  return join(paths.data, "roster.json");
}

export function loadRoster(paths: SintyPaths): RosterFile {
  const path = file(paths);
  if (!existsSync(path)) return empty();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RosterFile>;
    return {
      agents: Array.isArray(raw.agents) ? raw.agents.map(fillAgent) : [],
      projects: Array.isArray(raw.projects) ? raw.projects : [],
      sharedPlugins: Array.isArray(raw.sharedPlugins) ? raw.sharedPlugins : null,
    };
  } catch {
    return empty();
  }
}

function save(paths: SintyPaths, roster: RosterFile): void {
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(file(paths), JSON.stringify(roster, null, 2));
}

function slugOf(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40);
  return slug || "project";
}

export function projectDir(paths: SintyPaths, project: ProjectRecord): string {
  return join(paths.workspace, "projects", project.slug);
}

export function ensureProjectDirs(paths: SintyPaths, project: ProjectRecord): void {
  for (const name of ["_inbox", "_out", "_work"]) mkdirSync(join(projectDir(paths, project), name), { recursive: true });
}

export function listAgents(paths: SintyPaths): AgentRecord[] {
  return loadRoster(paths).agents;
}

export function saveAgent(paths: SintyPaths, input: Partial<AgentRecord> & { name: string }): AgentRecord {
  const roster = loadRoster(paths);
  const name = input.name.trim();
  if (!name) throw new Error("agent name is empty");
  if ((input.avatar ?? "").length > 300_000) throw new Error("avatar is larger than 200kb");
  const prev = input.id ? roster.agents.find((a) => a.id === input.id) : undefined;
  const next: AgentRecord = fillAgent({
    ...prev,
    ...input,
    id: prev?.id || input.id || `agt_${randomUUID().slice(0, 8)}`,
    name,
    skills: input.skills ?? prev?.skills ?? [],
    plugins: input.plugins ?? prev?.plugins ?? [],
    excludedPlugins: input.excludedPlugins ?? prev?.excludedPlugins ?? [],
  });
  const i = roster.agents.findIndex((a) => a.id === next.id);
  if (i >= 0) roster.agents[i] = next;
  else roster.agents.push(next);
  save(paths, roster);
  return next;
}

export function deleteAgent(paths: SintyPaths, id: string): void {
  const roster = loadRoster(paths);
  roster.agents = roster.agents.filter((a) => a.id !== id);
  for (const project of roster.projects) {
    project.agentIds = project.agentIds.filter((x) => x !== id);
    if (project.leadId === id) project.leadId = project.agentIds[0] ?? "";
  }
  save(paths, roster);
}

export function listProjects(paths: SintyPaths): ProjectRecord[] {
  return loadRoster(paths).projects;
}

export function saveProject(paths: SintyPaths, input: { id?: string; name: string; leadId?: string; agentIds?: string[] }): ProjectRecord {
  const roster = loadRoster(paths);
  const name = input.name.trim();
  if (!name) throw new Error("project name is empty");
  const agentIds = [...new Set((input.agentIds ?? []).filter((id) => roster.agents.some((a) => a.id === id)))];
  const existing = input.id ? roster.projects.find((p) => p.id === input.id) : undefined;
  const next: ProjectRecord = {
    id: existing?.id || `prj_${randomUUID().slice(0, 8)}`,
    name,
    slug: existing?.slug || uniqueSlug(roster, slugOf(name)),
    leadId: input.leadId && agentIds.includes(input.leadId) ? input.leadId : agentIds[0] ?? "",
    agentIds,
  };
  const i = roster.projects.findIndex((p) => p.id === next.id);
  if (i >= 0) roster.projects[i] = next;
  else roster.projects.push(next);
  save(paths, roster);
  ensureProjectDirs(paths, next);
  return next;
}

export function deleteProject(paths: SintyPaths, id: string): void {
  const roster = loadRoster(paths);
  roster.projects = roster.projects.filter((p) => p.id !== id);
  save(paths, roster);
}

/**
 * Whether a plugin is on for this agent. A default-on plugin (it replaces former core tools) is on unless the agent
 * lists it in `excludedPlugins`: agent cards saved before that plugin existed carry a plugin list without it and must
 * not lose the capability. Any other plugin follows the agent's own list, else the shared list (null: every plugin).
 */
export function agentHasPlugin(agent: AgentRecord, plugin: string, defaultOn: readonly string[], shared: string[] | null): boolean {
  if (defaultOn.includes(plugin)) return !agent.excludedPlugins.includes(plugin);
  if (agent.plugins.length > 0) return agent.plugins.includes(plugin);
  return shared === null || shared.includes(plugin);
}

export function sharedPlugins(paths: SintyPaths): string[] | null {
  return loadRoster(paths).sharedPlugins;
}

export function setSharedPlugins(paths: SintyPaths, names: string[]): string[] {
  const roster = loadRoster(paths);
  roster.sharedPlugins = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  save(paths, roster);
  return roster.sharedPlugins;
}

function fillAgent(raw: Partial<AgentRecord>): AgentRecord {
  return {
    id: raw.id || `agt_${randomUUID().slice(0, 8)}`,
    name: (raw.name ?? "").trim(),
    specialization: raw.specialization ?? "",
    summary: raw.summary ?? "",
    avatar: raw.avatar ?? "",
    persona: raw.persona ?? "",
    model: (raw.model ?? "").trim(),
    fallback: (raw.fallback ?? "").trim(),
    serviceModel: (raw.serviceModel ?? "").trim(),
    compress: raw.compress ?? "",
    facts: raw.facts ?? "",
    stallSeconds: typeof raw.stallSeconds === "number" && Number.isFinite(raw.stallSeconds) ? raw.stallSeconds : null,
    skills: [...new Set((raw.skills ?? []).map((s) => s.trim()).filter(Boolean))],
    plugins: [...new Set((raw.plugins ?? []).map((s) => s.trim()).filter(Boolean))],
    excludedPlugins: [...new Set((Array.isArray(raw.excludedPlugins) ? raw.excludedPlugins : []).map((s) => s.trim()).filter(Boolean))],
  };
}

function uniqueSlug(roster: RosterFile, base: string): string {
  const taken = new Set(roster.projects.map((p) => p.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const slug = `${base}-${n}`;
    if (!taken.has(slug)) return slug;
  }
  return `${base}-${randomUUID().slice(0, 4)}`;
}
