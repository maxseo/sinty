import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "@sinty/sdk";
import { parse, parseDocument } from "yaml";
import type { SintyPaths } from "./paths.js";

const decision = z.enum(["allow", "ask", "deny"]);

export const providerSchema = z.object({
  protocol: z.string(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

export const configSchema = z.object({
  agent: z
    .object({
      name: z.string().default("Sinty"),
      /** Shared memory owner. One value per install. */
      userId: z.string().default("local"),
      timezone: z.string().optional(),
      instructions: z.string().optional(),
    })
    .prefault({}),
  providers: z.record(z.string(), providerSchema).default({}),
  models: z
    .object({
      default: z.string().optional(),
      fallback: z.array(z.string()).default([]),
      routes: z.record(z.string(), z.string()).default({}),
      catalog: z.array(z.object({ route: z.string(), enabled: z.boolean() })).default([]),
      maxOutputTokens: z.number().int().positive().default(8192),
      /** Input+output tokens each plugin may spend per UTC day through ctx.models. 0 = unlimited. Default 200000. */
      pluginTokensPerDay: z.number().int().nonnegative().optional(),
    })
    .prefault({}),
  /** Side calls: summary and facts. Empty model uses models.default. Empty prompts use the built-in text. */
  service: z
    .object({
      model: z.string().default(""),
      compress: z.string().default(""),
      facts: z.string().default(""),
    })
    .prefault({}),
  plugins: z
    .object({
      enabled: z.array(z.string()).default(["provider-openai-compat", "provider-anthropic", "tool-fs", "ui-web", "kanban"]),
      config: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
      searchPaths: z.array(z.string()).default([]),
    })
    .prefault({}),
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().default(3180),
      token: z.string().default("secret://api.token"),
      /** Plugin whose static UI opens at `/`. */
      ui: z.string().default("ui-web"),
    })
    .prefault({}),
  supervisor: z
    .object({
      enabled: z.boolean().default(true),
      loopThreshold: z.number().int().default(3),
      stallSeconds: z.number().int().default(180),
      maxNoticesPerTurn: z.number().int().default(6),
      docsMaxChars: z.number().int().default(1500),
    })
    .prefault({}),
  memory: z
    .object({
      /** Model context window used to decide when the dialogue is summarized. */
      contextTokens: z.number().int().default(128000),
      /** sqlite-vec width. Fixed for the life of memory.db. */
      dimensions: z.number().int().default(1536),
    })
    .prefault({}),
});

export type SintyConfig = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;

const budgetSchema = z.object({
  steps: z.number().int().positive().optional(),
  tokens: z.number().int().positive().optional(),
  usd: z.number().positive().optional(),
  seconds: z.number().int().positive().optional(),
});

export const policySchema = z.object({
  mode: z.enum(["standard", "strict"]).default("standard"),
  defaults: z
    .object({
      none: decision.default("allow"),
      read: decision.default("allow"),
      write: decision.default("ask"),
      external: decision.default("ask"),
    })
    .prefault({}),
  tools: z.record(z.string(), decision).default({}),
  paths: z
    .array(z.object({ pattern: z.string(), access: z.enum(["read", "write"]), decision }))
    .default([]),
  net: z.object({ allow: z.array(z.string()).default([]) }).prefault({}),
  budgets: z
    .object({
      turn: budgetSchema.default({ steps: 60, tokens: 600_000, seconds: 1200 }),
    })
    .prefault({}),
  approvals: z
    .object({
      timeout: z.string().default("24h"),
      onTimeout: z.enum(["deny", "allow"]).default("deny"),
    })
    .prefault({}),
  agents: z.record(z.string(), z.object({ tools: z.record(z.string(), decision).default({}) })).default({}),
});

export type SintyPolicy = z.infer<typeof policySchema>;

export function loadConfig(paths: SintyPaths): SintyConfig {
  return configSchema.parse(readYaml(paths.config));
}

export function loadPolicy(paths: SintyPaths): SintyPolicy {
  return policySchema.parse(readYaml(paths.policy));
}

const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]*$/;
const MODEL_ROUTE = /^[a-z0-9][a-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Writes model, fallback and enabled plugins into config.yaml, and the persona into AGENTS.md. Secrets stay untouched. */
export const DEFAULT_COMPRESS_PROMPT = "Fold the transcript into one summary. Keep the user's goals, decisions, open promises, file paths and ids, and what is already done.";
export const DEFAULT_FACTS_PROMPT = "List durable facts that should outlive the transcript. tier profile is a stable preference, log is something that happened, note is temporary. about is user or work. One sentence per fact.";

export function saveSettings(
  paths: SintyPaths,
  patch: { model: string; fallback: string[]; enabled: string[]; agentsMd?: string; serviceModel?: string; compress?: string; facts?: string; stallSeconds?: number },
  providers: Record<string, unknown>,
): void {
  const model = patch.model.trim();
  const fallback = patch.fallback.map((r) => r.trim()).filter(Boolean);
  for (const route of [model, ...fallback]) {
    if (!MODEL_ROUTE.test(route)) throw new Error(`model must look like provider/model-id, got ${route}`);
    const provider = route.slice(0, route.indexOf("/"));
    if (!providers[provider]) throw new Error(`provider ${provider} is not in config.yaml`);
  }
  const enabled = [...new Set(patch.enabled.map((n) => n.trim()).filter(Boolean))];
  if (!enabled.includes("ui-web")) enabled.unshift("ui-web");
  for (const name of enabled) if (!PLUGIN_NAME.test(name)) throw new Error(`bad plugin name ${name}`);
  if (patch.agentsMd !== undefined && patch.agentsMd.length > 100_000) throw new Error("AGENTS.md is longer than 100000 characters");
  const serviceModel = (patch.serviceModel ?? "").trim();
  if (serviceModel) {
    if (!MODEL_ROUTE.test(serviceModel)) throw new Error(`model must look like provider/model-id, got ${serviceModel}`);
    const provider = serviceModel.slice(0, serviceModel.indexOf("/"));
    if (!providers[provider]) throw new Error(`provider ${provider} is not in config.yaml`);
  }
  for (const text of [patch.compress, patch.facts]) {
    if (text !== undefined && text.length > 20_000) throw new Error("a service prompt is longer than 20000 characters");
  }

  const doc = parseDocument(existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "");
  doc.setIn(["models", "default"], model);
  doc.setIn(["models", "fallback"], fallback);
  doc.setIn(["plugins", "enabled"], enabled);
  if (patch.stallSeconds !== undefined) {
    if (!Number.isInteger(patch.stallSeconds) || patch.stallSeconds < 0 || patch.stallSeconds > 3600) throw new Error("stall seconds must be a whole number from 0 to 3600");
    doc.setIn(["supervisor", "stallSeconds"], patch.stallSeconds);
  }
  if (patch.serviceModel !== undefined) doc.setIn(["service", "model"], serviceModel);
  if (patch.compress !== undefined) doc.setIn(["service", "compress"], patch.compress);
  if (patch.facts !== undefined) doc.setIn(["service", "facts"], patch.facts);
  writeFileSync(paths.config, String(doc));
  if (patch.agentsMd !== undefined) writeFileSync(paths.agents, patch.agentsMd);
}

export function saveModelCatalog(
  paths: SintyPaths,
  catalog: { route: string; enabled: boolean }[],
  providers: { id: string; baseUrl?: string; apiKey?: string; protocol?: string; remove?: boolean }[],
  known: Record<string, { protocol?: string } | undefined>,
): { route: string; enabled: boolean }[] {
  const doc = parseDocument(existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "");
  const clean = catalog
    .map((m) => ({ route: m.route.trim(), enabled: m.enabled }))
    .filter((m) => m.enabled && MODEL_ROUTE.test(m.route));
  for (const row of providers) {
    const id = row.id.trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`bad provider id ${id}`);
    if (row.remove) {
      doc.deleteIn(["providers", id]);
      continue;
    }
    const protocol = row.protocol === "anthropic" || row.protocol === "openai-responses" ? row.protocol : "openai-compat";
    if (!known[id] && row.baseUrl) {
      doc.setIn(["providers", id], { protocol, baseUrl: row.baseUrl.trim() });
    } else if (row.baseUrl) {
      doc.setIn(["providers", id, "baseUrl"], row.baseUrl.trim());
      if (row.protocol) doc.setIn(["providers", id, "protocol"], protocol);
    }
    if (row.apiKey?.trim()) doc.setIn(["providers", id, "apiKey"], `secret://${id}`);
  }
  doc.setIn(["models", "catalog"], clean);
  writeFileSync(paths.config, String(doc));
  return clean;
}

function readYaml(file: string): unknown {
  if (!existsSync(file)) return {};
  const parsed: unknown = parse(readFileSync(file, "utf8"));
  return parsed ?? {};
}

export const DEFAULT_CONFIG_YAML = `# Sinty configuration. Owned by the core: no tool can write this file.
agent:
  name: Sinty

providers:
  # secret values: sinty secret set <name>
  anthropic: { protocol: anthropic, apiKey: secret://anthropic }
  openai:    { protocol: openai-compat, baseUrl: https://api.openai.com/v1, apiKey: secret://openai }
  xai:       { protocol: openai-compat, baseUrl: https://api.x.ai/v1, apiKey: secret://xai }
  deepseek:  { protocol: openai-compat, baseUrl: https://api.deepseek.com/v1, apiKey: secret://deepseek }
  local:     { protocol: openai-compat, baseUrl: http://127.0.0.1:11434/v1 }

models:
  # provider/model-id, e.g. deepseek/deepseek-chat
  default: ""
  fallback: []
  routes: {}

plugins:
  enabled: [provider-openai-compat, provider-anthropic, tool-fs, ui-web, kanban]
  # optional: provider-openai-responses, server-openai-api, server-mcp, server-agui
  # M4, off until configured: channel-webhook, channel-telegram, channel-voice, server-a2a, delegate, herdr, otel, syntet

server:
  host: 127.0.0.1
  port: 3180
  token: secret://api.token
`;

export const DEFAULT_POLICY_YAML = `# Sinty policy. Owned by the core: no tool can write this file.
mode: standard

defaults:
  none: allow
  read: allow
  write: ask
  external: ask

tools:
  "fs.read": allow
  "fs.list": allow
  "fs.write": allow
  "fs.edit": allow
  # The agent may read and test patches for its plugins; activating one needs a human.
  "plugin.list": allow
  "plugin.read": allow
  "plugin.propose_patch": allow
  "plugin.apply_patch": ask
  "kanban.*": allow
  "memory.recall": allow
  "memory.write": allow
  "memory.forget": allow
  "skill.*": allow
  "syntet.*": ask
  "delegate.run": ask

net:
  allow:
    - api.anthropic.com
    - api.openai.com
    - api.x.ai
    - api.deepseek.com
    - 127.0.0.1
    - localhost

budgets:
  turn: { steps: 60, tokens: 600000, seconds: 1200 }

approvals:
  timeout: 24h
  onTimeout: deny
`;

export const DEFAULT_AGENTS_MD = `# Agent rules

- Answer in the language of the user.
- Work inside the workspace folder. Ask before destructive actions.
- When a tool fails, read the error and the hint, fix the arguments, do not repeat the same call blindly.
`;
