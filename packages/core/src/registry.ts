import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "@sinty/sdk";
import type { SintyPaths } from "./paths.js";

const entry = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  kinds: z.array(z.string()),
});

const fileSchema = z.object({
  protocol: z.literal("sinty/1.0"),
  plugins: z.array(entry),
});

export type RegistryEntry = z.infer<typeof entry>;

/** Catalog of plugins shipped with this install. Enabling one is still a line in config.yaml. */
export function loadRegistry(paths: SintyPaths): RegistryEntry[] {
  const file = join(paths.install, "registry", "plugins.json");
  if (!existsSync(file)) return [];
  return fileSchema.parse(JSON.parse(readFileSync(file, "utf8"))).plugins;
}
