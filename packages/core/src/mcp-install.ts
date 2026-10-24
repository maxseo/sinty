import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import type { PluginManifest } from "@sinty/sdk";
import type { SintyConfig } from "./config.js";
import type { PluginHost } from "./host/host.js";
import { parseManifest } from "./host/manifest.js";
import { isInside, type SintyPaths } from "./paths.js";

/** Safe plugin id: same pattern as sinty.plugin.json `name`. */
const PLUGIN_NAME = /^[a-z][a-z0-9-]{1,63}$/;
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const SECRET_REF = /^secret:\/\/([A-Za-z][A-Za-z0-9._-]{0,63})$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
/** Folder names the home plugins tree reserves (staging, git). */
const RESERVED_FOLDERS = new Set([".staging", ".git", "node_modules"]);

export class McpInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "McpInstallError";
  }
}

export interface McpInstallInput {
  name: string;
  description?: string;
  version?: string;
  runtime: "mcp-stdio" | "http";
  /** Required for mcp-stdio. First element is the executable. */
  command?: string[];
  /** Required for http. */
  url?: string;
  permissions?: {
    net?: string[];
    /** Secret *names* (not values). Also accepted as `secret://name`. */
    secrets?: string[];
    /** Host env var names the plugin process may see. */
    env?: string[];
  };
  /**
   * Optional env for the MCP child: values must be `secret://<name>` (never raw secrets).
   * Stored in config.yaml `plugins.config.<name>.env` and folded into permissions.secrets.
   */
  env?: Record<string, string>;
  /** Replace an existing home plugin folder. Never replaces a bundled plugin. Default false. */
  replace?: boolean;
}

export interface McpInstallResult {
  name: string;
  runtime: "mcp-stdio" | "http";
  version: string;
  description: string;
  location: "home";
  tools: string[];
  enabled: boolean;
  started: boolean;
  /** Set when the plugin was written and enabled but hot-start failed. */
  startError?: string;
  /** Hint for the agent / UI (per-agent enable is phase 3). */
  next?: string;
}

/**
 * Writes a new MCP plugin under `$SINTY_HOME/plugins/<name>/`, enables it in config.yaml,
 * and hot-starts it through the existing PluginHost.reload path.
 */
export async function installMcpPlugin(paths: SintyPaths, config: SintyConfig, host: PluginHost, input: McpInstallInput): Promise<McpInstallResult> {
  const name = validateName(input.name);
  const runtime = input.runtime;
  if (runtime !== "mcp-stdio" && runtime !== "http") {
    throw new McpInstallError("bad_request", `runtime must be mcp-stdio or http, got ${String(runtime)}`);
  }

  const homeDir = join(paths.plugins, name);
  assertSafeHomeDir(paths, homeDir, name);

  const bundledDir = join(paths.bundledPlugins, name);
  if (existsSync(join(bundledDir, "sinty.plugin.json"))) {
    throw new McpInstallError(
      "bundled",
      `plugin ${name} is a bundled plugin and cannot be overwritten by mcp.install`,
      "Pick another name, or fork the bundled plugin with plugin.propose_patch.",
    );
  }

  const replace = input.replace === true;
  if (existsSync(homeDir)) {
    if (!replace) {
      throw new McpInstallError("exists", `plugin folder already exists at ${homeDir}`, "Pass replace: true to overwrite, or pick another name.");
    }
    await host.unload(name);
    rmSync(homeDir, { recursive: true, force: true });
  }

  const { secrets, envNames, envMap } = normalizeSecrets(input);
  const permissions: PluginManifest["permissions"] = {
    ...(input.permissions?.net?.length ? { net: [...input.permissions.net] } : {}),
    ...(secrets.length ? { secrets } : {}),
    ...(envNames.length ? { env: envNames } : {}),
  };

  const version = (input.version ?? "0.1.0").trim();
  if (!VERSION.test(version)) throw new McpInstallError("bad_request", `version must look like 1.2.3, got ${version}`);
  const description = (input.description?.trim() || `MCP server ${name}`).slice(0, 300);

  const raw: Record<string, unknown> = {
    name,
    version,
    description,
    kinds: ["tool"],
    runtime,
    permissions,
    editable: true,
  };
  if (runtime === "mcp-stdio") {
    const command = input.command;
    if (!Array.isArray(command) || !command.length || !command.every((c) => typeof c === "string" && c.length > 0)) {
      throw new McpInstallError("bad_request", "mcp-stdio needs command: a non-empty string array", 'Example: ["npx", "-y", "@modelcontextprotocol/server-github"]');
    }
    if (command.some((c) => c.includes("\0"))) throw new McpInstallError("bad_request", "command must not contain null bytes");
    raw.command = command;
  } else {
    const url = (input.url ?? "").trim();
    if (!url) throw new McpInstallError("bad_request", "http runtime needs url", "Pass an https MCP endpoint URL.");
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
    } catch {
      throw new McpInstallError("bad_request", `url must be http(s), got ${url}`);
    }
    raw.url = url;
  }

  let manifest: PluginManifest;
  try {
    manifest = parseManifest(raw);
  } catch (e) {
    throw new McpInstallError("bad_manifest", e instanceof Error ? e.message : String(e), "Fix the install arguments to match sinty.plugin.json.");
  }

  mkdirSync(homeDir, { recursive: true });
  writeFileSync(join(homeDir, "sinty.plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  if (Object.keys(envMap).length) {
    writePluginConfigEnv(paths, name, envMap);
    config.plugins.config[name] = { ...(config.plugins.config[name] ?? {}), env: envMap };
  }

  enablePluginInConfig(paths, name);
  if (!config.plugins.enabled.includes(name)) config.plugins.enabled = [...config.plugins.enabled, name];

  const startError = await host.reload(name);
  const proc = host.plugins.get(name);
  const tools = proc && !proc.disabled ? proc.tools.map((t) => t.name) : [];
  const started = Boolean(proc) && !startError;

  return {
    name,
    runtime,
    version: manifest.version,
    description: manifest.description,
    location: "home",
    tools,
    enabled: true,
    started,
    ...(startError ? { startError } : {}),
    next: started
      ? "MCP tools are loaded for the harness. Enable this plugin on an agent card (MCP tab) if it is not already shared/default-on."
      : "The plugin folder was written and enabled; fix startError (or restart sinty web) then enable it on the agent if needed.",
  };
}

function validateName(raw: string): string {
  const name = raw.trim();
  if (!PLUGIN_NAME.test(name)) {
    throw new McpInstallError("bad_name", `name must match ${PLUGIN_NAME}, got ${JSON.stringify(raw)}`, "Use a lowercase id like github or postgres-local.");
  }
  if (RESERVED_FOLDERS.has(name) || name.startsWith(".")) {
    throw new McpInstallError("bad_name", `name ${name} is reserved`, "Pick another plugin id.");
  }
  if (name.includes("..") || name.includes("/") || name.includes("\\") || name.includes(sep)) {
    throw new McpInstallError("bad_name", "name must not contain path separators", "Use a flat id, not a path.");
  }
  return name;
}

function assertSafeHomeDir(paths: SintyPaths, homeDir: string, name: string): void {
  const resolved = resolve(homeDir);
  if (!isInside(resolved, paths.plugins) || resolved === resolve(paths.plugins)) {
    throw new McpInstallError("bad_name", `refusing to write outside plugins home for ${name}`);
  }
}

function normalizeSecrets(input: McpInstallInput): { secrets: string[]; envNames: string[]; envMap: Record<string, string> } {
  const secretSet = new Set<string>();
  for (const s of input.permissions?.secrets ?? []) {
    if (typeof s !== "string" || !s.trim()) throw new McpInstallError("bad_request", "permissions.secrets entries must be non-empty strings");
    secretSet.add(secretName(s.trim()));
  }
  const envNames = new Set<string>();
  for (const e of input.permissions?.env ?? []) {
    if (typeof e !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e)) {
      throw new McpInstallError("bad_request", `bad env name ${JSON.stringify(e)}`, "Env names are identifiers like GITHUB_TOKEN.");
    }
    envNames.add(e);
  }
  const envMap: Record<string, string> = {};
  if (input.env) {
    for (const [key, value] of Object.entries(input.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new McpInstallError("bad_request", `bad env key ${JSON.stringify(key)}`);
      if (typeof value !== "string") throw new McpInstallError("bad_request", `env.${key} must be a secret:// reference, not a raw value`);
      const m = SECRET_REF.exec(value.trim());
      if (!m) {
        throw new McpInstallError(
          "bad_request",
          `env.${key} must be secret://<name> (raw secret values are refused)`,
          "Store the secret with sinty secret set <name>, then pass secret://<name>.",
        );
      }
      const sn = m[1]!;
      secretSet.add(sn);
      envNames.add(key);
      envMap[key] = `secret://${sn}`;
    }
  }
  for (const s of secretSet) {
    if (!SECRET_NAME.test(s)) throw new McpInstallError("bad_request", `bad secret name ${s}`);
  }
  return { secrets: [...secretSet], envNames: [...envNames], envMap };
}

function secretName(s: string): string {
  const m = SECRET_REF.exec(s);
  if (m) return m[1]!;
  if (SECRET_NAME.test(s)) return s;
  throw new McpInstallError("bad_request", `bad secret reference ${JSON.stringify(s)}`, "Use a name like github.token or secret://github.token.");
}

/** Appends `name` to config.yaml plugins.enabled without touching models/secrets. */
export function enablePluginInConfig(paths: SintyPaths, name: string): void {
  const doc = parseDocument(existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "");
  const node = doc.getIn(["plugins", "enabled"]);
  const list: string[] =
    node && typeof (node as { toJSON?: () => unknown }).toJSON === "function"
      ? (((node as { toJSON: () => unknown }).toJSON() as unknown[]) ?? []).filter((x): x is string => typeof x === "string")
      : Array.isArray(node)
        ? (node as string[])
        : [];
  if (!list.includes(name)) {
    doc.setIn(["plugins", "enabled"], [...list, name]);
    writeFileSync(paths.config, String(doc));
  }
}

function writePluginConfigEnv(paths: SintyPaths, name: string, envMap: Record<string, string>): void {
  const doc = parseDocument(existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "");
  doc.setIn(["plugins", "config", name, "env"], envMap);
  writeFileSync(paths.config, String(doc));
}
