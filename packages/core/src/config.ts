import { existsSync, readFileSync } from "node:fs";
import { z } from "@sinty/sdk";
import { parse } from "yaml";
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
      instructions: z.string().optional(),
    })
    .prefault({}),
  providers: z.record(z.string(), providerSchema).default({}),
  models: z
    .object({
      default: z.string().optional(),
      fallback: z.array(z.string()).default([]),
      routes: z.record(z.string(), z.string()).default({}),
      maxOutputTokens: z.number().int().positive().default(8192),
    })
    .prefault({}),
  plugins: z
    .object({
      enabled: z.array(z.string()).default(["provider-openai-compat", "provider-anthropic", "tool-fs"]),
      config: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
      searchPaths: z.array(z.string()).default([]),
    })
    .prefault({}),
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().default(3180),
      token: z.string().default("secret://api.token"),
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
  enabled: [provider-openai-compat, provider-anthropic, tool-fs]

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
