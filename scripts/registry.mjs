import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const plugins = [];
for (const name of readdirSync(join(root, "plugins")).sort()) {
  const file = join(root, "plugins", name, "sinty.plugin.json");
  try {
    const m = JSON.parse(readFileSync(file, "utf8"));
    if (m.name === "example-echo") continue;
    plugins.push({ name: m.name, version: m.version, description: m.description, kinds: m.kinds });
  } catch {
    /* not a plugin folder */
  }
}
mkdirSync(join(root, "registry"), { recursive: true });
writeFileSync(join(root, "registry", "plugins.json"), JSON.stringify({ protocol: "sinty/1.0", plugins }, null, 2) + "\n");
console.log(`registry: ${plugins.length} plugins`);
