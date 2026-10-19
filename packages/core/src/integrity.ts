import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Files the install is allowed to replace. `node_modules` is not hashed: it is installed beside this tree. */
const ROOTS = ["packages", "plugins", "schemas", "registry", "site"];

export interface IntegrityFile {
  files: Record<string, string>;
}

export function readIntegrity(root: string): IntegrityFile | undefined {
  const file = join(root, "integrity.json");
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as IntegrityFile;
}

export function hashInstall(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ROOTS) {
    const dir = join(root, name);
    if (existsSync(dir)) walk(dir, root, out);
  }
  return out;
}

function walk(dir: string, root: string, out: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "src" || entry.name === "__tests__") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, root, out);
    else if (entry.isFile() && !entry.name.endsWith(".map") && !entry.name.endsWith(".ts")) {
      const rel = relative(root, abs).split("\\").join("/");
      out[rel] = createHash("sha256").update(readFileSync(abs)).digest("hex");
    }
  }
}

export function checkIntegrity(root: string): { ok: boolean; problems: string[] } {
  const expected = readIntegrity(root);
  if (!expected) return { ok: true, problems: [] };
  const actual = hashInstall(root);
  const problems: string[] = [];
  for (const [file, hash] of Object.entries(expected.files)) {
    if (!actual[file]) problems.push(`missing ${file}`);
    else if (actual[file] !== hash) problems.push(`changed ${file}`);
  }
  return { ok: problems.length === 0, problems };
}

export function installLooksStrictUnsafe(): string | undefined {
  if (process.platform === "win32") return "strict mode on Windows keeps the Node permission model only; separate OS users need Linux";
  if (typeof process.getuid === "function" && process.getuid() === 0) return "strict mode refuses to run as root; start Sinty as the sinty user";
  return undefined;
}
