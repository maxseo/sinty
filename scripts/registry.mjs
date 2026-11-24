import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

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
const outFlag = process.argv.indexOf("--out");
if(outFlag>=0&&!process.argv[outFlag+1])throw Error("--out requires a destination file");
const output = outFlag>=0 ? resolve(process.argv[outFlag+1]) : join(root,"registry","plugins.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({protocol:"sinty/1.0",plugins},null,2)+"\n");
console.log(JSON.stringify({plugins:plugins.length,output}));
