import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "@sinty/sdk";
import type { SintyPaths } from "./paths.js";
import { loadRegistry, type RegistryEntry } from "./registry.js";

const entry = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  kinds: z.array(z.string()),
});

/** Skip staging / VCS noise under $SINTY_HOME/plugins. */
const SKIP_DIRS = new Set([".staging", ".git", "node_modules"]);

function readManifestEntry(dir: string): RegistryEntry | undefined {
  const file = join(dir, "sinty.plugin.json");
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const m = entry.parse(raw);
    const folder = dir.split(/[/\\]/).pop() ?? m.name;
    if (folder !== m.name) return undefined;
    return m;
  } catch {
    return undefined;
  }
}

function scanRoot(root: string): RegistryEntry[] {
  if (!existsSync(root)) return [];
  const out: RegistryEntry[] = [];
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory() || SKIP_DIRS.has(name.name) || name.name.startsWith(".")) continue;
    const e = readManifestEntry(join(root, name.name));
    if (e) out.push(e);
  }
  return out;
}

/**
 * Full harness catalog for Settings → Plugins: bundled registry plus every home (and
 * searchPaths) plugin folder that has a valid sinty.plugin.json — including opt-in off ones.
 */
export function discoverPlugins(paths: SintyPaths, searchPaths: readonly string[] = []): RegistryEntry[] {
  const byName = new Map<string, RegistryEntry>();
  for (const p of loadRegistry(paths)) byName.set(p.name, p);
  // Home overrides registry metadata when both exist (home wins for version/description).
  for (const p of scanRoot(paths.plugins)) byName.set(p.name, p);
  for (const rel of searchPaths) {
    const root = resolve(paths.home, rel);
    for (const p of scanRoot(root)) {
      if (!byName.has(p.name)) byName.set(p.name, p);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}