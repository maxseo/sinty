import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z, type PluginManifest } from "@sinty/sdk";
import { checkFsGrant } from "../policy.js";
import { isInside, type SintyPaths } from "../paths.js";

const manifestSchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
    description: z.string().min(1).max(300),
    kinds: z.array(z.enum(["provider", "tool", "context", "channel", "server", "schedule", "event", "ui"])).min(1),
    runtime: z.enum(["node", "mcp-stdio", "http"]),
    entry: z.string().optional(),
    command: z.array(z.string()).min(1).optional(),
    url: z.string().optional(),
    permissions: z
      .object({
        fs: z.object({ read: z.array(z.string()).optional(), write: z.array(z.string()).optional() }).strict().optional(),
        net: z.array(z.string()).optional(),
        secrets: z.array(z.string()).optional(),
        env: z.array(z.string()).optional(),
        shell: z.boolean().optional(),
      })
      .strict(),
    tools: z
      .array(
        z
          .object({
            name: z.string(),
            description: z.string().optional(),
            sideEffects: z.enum(["none", "read", "write", "external"]),
            idempotent: z.boolean().optional(),
            recoverable: z.boolean().optional(),
            docs: z.string().optional(),
            defaultPolicy: z.enum(["allow", "ask", "deny"]).optional(),
          })
          .strict(),
      )
      .optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    tests: z.string().optional(),
    editable: z.boolean().optional(),
  })
  .strict();

export interface LoadedManifest {
  dir: string;
  manifest: PluginManifest;
  /** Bundled plugins live in the read-only install dir. */
  bundled: boolean;
}

export function findPlugin(paths: SintyPaths, name: string, searchPaths: readonly string[]): LoadedManifest {
  const roots = [paths.plugins, ...searchPaths.map((p) => resolve(paths.home, p)), paths.bundledPlugins];
  for (const root of roots) {
    const dir = join(root, name);
    const file = join(dir, "sinty.plugin.json");
    if (!existsSync(file)) continue;
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(file, "utf8"))) as PluginManifest;
    if (manifest.name !== name) throw new Error(`${file}: name "${manifest.name}" does not match folder "${name}"`);
    return { dir, manifest, bundled: isInside(dir, paths.install) };
  }
  throw new Error(`plugin ${name} not found in ${roots.join(", ")}`);
}

export interface FsGrants {
  read: string[];
  write: string[];
}

/** Expands `$WORKSPACE`, `$SKILLS`, `$PLUGIN` and relative paths; rejects grants that touch core-owned files. */
export function resolveFsGrants(paths: SintyPaths, loaded: LoadedManifest): FsGrants {
  const expand = (p: string): string => {
    const replaced = p
      .replace(/^\$WORKSPACE/, paths.workspace)
      .replace(/^\$SKILLS/, paths.skills)
      .replace(/^\$PLUGIN/, loaded.dir);
    return isAbsolute(replaced) ? resolve(replaced) : resolve(loaded.dir, replaced);
  };
  const fs = loaded.manifest.permissions.fs ?? {};
  const read = (fs.read ?? []).map(expand);
  const write = (fs.write ?? []).map(expand);
  for (const p of read) {
    const err = checkFsGrant(paths, p, "read");
    if (err) throw new Error(`plugin ${loaded.manifest.name}: ${err}`);
  }
  for (const p of write) {
    const err = checkFsGrant(paths, p, "write");
    if (err) throw new Error(`plugin ${loaded.manifest.name}: ${err}`);
    if (isInside(p, loaded.dir) || isInside(p, paths.plugins) || isInside(paths.plugins, p)) {
      throw new Error(`plugin ${loaded.manifest.name}: may not write plugin code (${p}); use plugin.propose_patch`);
    }
  }
  return { read, write };
}
