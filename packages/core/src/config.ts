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
      /** Max concurrent background agent.task children under one parent (like kanban maxParallel). */
      taskMaxParallel: z.number().int().min(1).default(3),
      /**
       * Shared token budget for a parent turn plus its agent.task children (tree). 0 = no shared cap
       * (each session still has its own turn budget).
       */
      taskTreeTokens: z.number().int().min(0).default(0),
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
      /** Context window per route ("provider/model": tokens) when the provider does not report it. */
      contextWindows: z.record(z.string(), z.number().int().positive()).optional(),
      /** Input+output tokens each plugin may spend per UTC day through ctx.models. 0 = unlimited. Default 2000000. */
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
      /**
       * Bundled plugins that are on by default (DEFAULT_ON_PLUGINS, e.g. tool-web) and that the human turned off.
       * A config.yaml without this key keeps them on, so configs from before they left the core keep working.
       */
      disabled: z.array(z.string()).optional(),
      /**
       * Plugins allowed to receive context snapshots (the full prompt of every model step, private memory included).
       * Off by default; the plugin's manifest must also ask for permissions.context ["inspect"]. See docs/spec/context-inspect.md.
       */
      inspect: z.array(z.string()).optional(),
    })
    .prefault({}),
  /** shell.run on Linux: bubblewrap sandbox (see shell-sandbox.ts and docs/spec/policy.md). Windows always uses its cage. */
  shell: z
    .object({
      sandbox: z.enum(["auto", "bwrap", "off"]).optional(),
      network: z.boolean().optional(),
      passEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(),
    })
    .optional(),
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().default(3180),
      token: z.string().default("secret://api.token"),
      /** Plugin whose static UI opens at `/`. */
      ui: z.string().default("ui-web"),
    })
    .prefault({}),
  /** Supervisor limits; editable in the Web UI (Settings → Супервизор). See docs/spec/supervisor.md. */
  supervisor: z
    .object({
      enabled: z.boolean().default(true),
      /** Identical calls before a loop notice. */
      loopThreshold: z.number().int().min(1).default(3),
      /** Identical calls before the turn is stopped; 0 never stops. Unset: loopThreshold + 2. */
      loopBlockAfter: z.number().int().min(0).optional(),
      /** Silence of a model or tool call before a warning; twice as long stops the turn (stallBlock). 0 = off. */
      stallSeconds: z.number().int().min(0).default(180),
      stallBlock: z.boolean().default(true),
      maxNoticesPerTurn: z.number().int().min(1).default(6),
      maxNoticesPerDetector: z.number().int().min(1).default(2),
      /** When notices exceed their limits: stop the turn and ask the human (true), or just stop sending notices. */
      escalate: z.boolean().default(true),
      /** Same tool + error code in a turn before the notice says "do not repeat". */
      repeatFailures: z.number().int().min(1).default(2),
      /** Turns a tool failed in before the notice suggests a plugin patch; 0 never. */
      patchAfterTurns: z.number().int().min(0).default(3),
      /** Tool docs quoted in failure notices (the failing tool's section, once per tool per turn), characters; 0 none. */
      docsMaxChars: z.number().int().min(0).default(500),
      useIncidents: z.boolean().default(true),
      checks: z
        .object({
          toolErrors: z.boolean().default(true),
          loop: z.boolean().default(true),
          budget: z.boolean().default(true),
          badOutput: z.boolean().default(true),
        })
        .prefault({}),
      /**
       * Turn budget. steps/tokens/seconds set here override `budgets.turn` in policy.yaml; unset ones come from it.
       * `count` decides what a token is (see budgetTokens in @sinty/supervisor): "weighted" (default) counts cached
       * prompt tokens at `cachedWeight`, "uncached" ignores them, "all" counts every prompt token.
       */
      budget: z
        .object({
          steps: z.number().int().min(0).optional(),
          tokens: z.number().int().min(0).optional(),
          seconds: z.number().int().min(0).optional(),
          count: z.enum(["all", "uncached", "weighted"]).default("weighted"),
          cachedWeight: z.number().min(0).max(1).default(0.1),
          warnAt: z.number().min(0).max(1).default(0.8),
          /** Stop the turn at the limit (true) or only warn (false). */
          stop: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),
  memory: z
    .object({
      /**
       * Model context window used to decide when the dialogue is summarized (folds at 65%). "auto" (default): the
       * window of the chat's model (models.contextWindows, what the provider's model list reports, the bundled
       * table in context-window.ts, else 128000). A number overrides it for every model.
       */
      contextTokens: z.union([z.literal("auto"), z.number().int().positive()]).default("auto"),
      /**
       * Fold the dialogue no later than this many (real) tokens, even when 65% of the window is more: the compaction
       * point is min(0.65 × window, cap). Absent: 150000. 0 or null: no cap. Settings → Память и контекст.
       */
      compactCapTokens: z.number().int().nonnegative().nullable().optional(),
      /** sqlite-vec width; must equal the embedding model's width. After a change run `sinty memory reembed`. */
      dimensions: z.number().int().default(1536),
      /**
       * Vectors of facts with none or of another embedding model (models.routes.embed changed): "manual" (default)
       * leaves them to `sinty memory reembed`, "auto" embeds them in the background on start.
       */
      reembed: z.enum(["manual", "auto"]).optional(),
      /** Plugin memory providers used for recall. Unset: every enabled one. See docs/spec/memory.md. */
      providers: z.array(z.string()).optional(),
      /** Plugin memory providers that receive mirrored writes and forgets. Default: none. */
      writeTo: z.array(z.string()).optional(),
      recall: z
        .object({
          /** Recall with the user's message at the start of every turn even without a processor plan. */
          auto: z.boolean().optional(),
          limit: z.number().int().positive().optional(),
          budgetTokens: z.number().int().positive().optional(),
          timeoutMs: z.number().int().positive().optional(),
        })
        .optional(),
      hooks: z
        .object({
          timeoutMs: z.number().int().positive().optional(),
          afterTurnTimeoutMs: z.number().int().positive().optional(),
          /** How long shutdown waits for queued afterTurn jobs. Default: afterTurnTimeoutMs, at most 15000. */
          closeTimeoutMs: z.number().int().nonnegative().optional(),
        })
        .optional(),
      /** A/B arms for memory recall, assigned by a hash of the session id. See docs/spec/memory.md. */
      experiments: z
        .array(
          z.object({
            name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
            arms: z
              .array(
                z.object({
                  name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
                  weight: z.number().nonnegative().default(1),
                  recall: z.object({ auto: z.boolean().optional(), limit: z.number().int().positive().optional(), budgetTokens: z.number().int().positive().optional() }).optional(),
                  providers: z.array(z.string()).optional(),
                }),
              )
              .min(1),
            /** Arms whose recall also runs for every turn, journaled with shadow: true, never shown to the model. */
            shadow: z.array(z.string()).default([]),
          }),
        )
        .optional(),
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

/**
 * Bundled plugins that are enabled unless config.yaml lists them in `plugins.disabled`. tool-web carries web.search, tool-vision carries vision.look,
 * web.read, web.links, web.screenshot and web.interact; skills carries the skill.* tools and the skills catalog of
 * the prompt; mcp-catalog owns Settings → MCP. All of them were core before plan step 7: an existing config.yaml whose plugins.enabled predates the
 * move keeps them without being rewritten.
 */
export const DEFAULT_ON_PLUGINS: readonly string[] = ["tool-web", "tool-vision", "skills", "responsive-turn", "mcp-catalog"];

/** Appends DEFAULT_ON_PLUGINS that are neither enabled nor disabled, in memory. Idempotent. */
export function withDefaultPlugins<T extends { plugins: { enabled: string[]; disabled?: string[] | undefined } }>(config: T): T {
  const disabled = new Set(config.plugins.disabled ?? []);
  for (const name of DEFAULT_ON_PLUGINS) {
    if (!config.plugins.enabled.includes(name) && !disabled.has(name)) config.plugins.enabled = [...config.plugins.enabled, name];
  }
  return config;
}

export function loadConfig(paths: SintyPaths): SintyConfig {
  return withDefaultPlugins(configSchema.parse(readYaml(paths.config)));
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
  patch: { model: string; fallback?: string[]; enabled: string[]; agentsMd?: string; serviceModel?: string; compress?: string; facts?: string; stallSeconds?: number },
  providers: Record<string, unknown>,
): void {
  const model = patch.model.trim();
  const fallback = patch.fallback === undefined ? undefined : patch.fallback.map((r) => r.trim()).filter(Boolean);
  for (const route of [model, ...(fallback ?? [])]) {
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
  if (fallback !== undefined) doc.setIn(["models", "fallback"], fallback);
  doc.setIn(["plugins", "enabled"], enabled);
  // A default-on plugin the human unticked goes to plugins.disabled; ticking it again takes it out.
  const disabledNode = doc.getIn(["plugins", "disabled"]);
  const wasDisabled = disabledNode && typeof (disabledNode as { toJSON?: () => unknown }).toJSON === "function" ? ((disabledNode as { toJSON: () => unknown }).toJSON() as unknown[]) : [];
  const disabled = new Set((Array.isArray(wasDisabled) ? wasDisabled : []).filter((n): n is string => typeof n === "string"));
  for (const name of DEFAULT_ON_PLUGINS) {
    if (enabled.includes(name)) disabled.delete(name);
    else disabled.add(name);
  }
  if (disabled.size) doc.setIn(["plugins", "disabled"], [...disabled]);
  else if (doc.hasIn(["plugins", "disabled"])) doc.deleteIn(["plugins", "disabled"]);
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

/** Well-known named model routes shown in Settings → Models (docs: cheap/embed/vision/long). */
export const NAMED_MODEL_ROUTES = ["cheap", "embed", "vision", "long"] as const;

/**
 * Deep-merge models.routes into config.yaml.
 * Invariant: omitted keys are preserved; only keys present in `patch` are written.
 * Empty string clears that named route. Never replaces the whole routes map with a partial UI payload.
 * Extra custom keys already in config stay unless explicitly patched.
 */
export function saveNamedRoutes(
  paths: SintyPaths,
  patch: Record<string, string>,
  providers: Record<string, unknown>,
): Record<string, string> {
  const doc = parseDocument(existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "");
  const existingNode = doc.getIn(["models", "routes"]);
  const existingRaw =
    existingNode && typeof (existingNode as { toJSON?: () => unknown }).toJSON === "function"
      ? ((existingNode as { toJSON: () => unknown }).toJSON() as unknown)
      : existingNode;
  const next: Record<string, string> = {};
  if (existingRaw && typeof existingRaw === "object" && !Array.isArray(existingRaw)) {
    for (const [k, v] of Object.entries(existingRaw as Record<string, unknown>)) {
      if (typeof k === "string" && typeof v === "string" && v.trim()) next[k] = v.trim();
    }
  }
  for (const [key, raw] of Object.entries(patch)) {
    const name = key.trim();
    if (!name || name === "default") continue;
    const value = (raw ?? "").trim();
    if (!value) {
      delete next[name];
      continue;
    }
    if (!MODEL_ROUTE.test(value)) throw new Error("model must look like provider/model-id, got " + value);
    const provider = value.slice(0, value.indexOf("/"));
    if (!providers[provider]) throw new Error("provider " + provider + " is not in config.yaml");
    next[name] = value;
  }
  doc.setIn(["models", "routes"], next);
  writeFileSync(paths.config, String(doc));
  return next;
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
  # tool-web (web.search, web.read, ...) is on unless listed here: disabled: [tool-web]

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
  "plugin.create": allow
  "plugin.apply_patch": ask
  "mcp.install": ask
  "kanban.*": allow
  "site.*": allow
  "hyperframes.*": allow
  "runtimes.*": allow
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

/** The turn budget in effect: config.yaml `supervisor.budget` values win; 0 there means "no limit"; unset ones come from policy.yaml. */
export function effectiveBudget(config: SintyConfig, policy: SintyPolicy): { steps?: number; tokens?: number; seconds?: number; count: "all" | "uncached" | "weighted"; cachedWeight: number; warnAt: number; stop: boolean } {
  const c = config.supervisor.budget;
  const p = policy.budgets.turn;
  const pick = (own: number | undefined, fromPolicy: number | undefined): number | undefined => {
    const v = own ?? fromPolicy;
    return v ? v : undefined;
  };
  const out: ReturnType<typeof effectiveBudget> = { count: c.count, cachedWeight: c.cachedWeight, warnAt: c.warnAt, stop: c.stop };
  const steps = pick(c.steps, p.steps);
  const tokens = pick(c.tokens, p.tokens);
  const seconds = pick(c.seconds, p.seconds);
  if (steps) out.steps = steps;
  if (tokens) out.tokens = tokens;
  if (seconds) out.seconds = seconds;
  return out;
}
