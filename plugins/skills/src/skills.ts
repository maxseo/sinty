import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface SkillInfo {
  name: string;
  description: string;
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/i;
const MAX_READ = 24_000;

export function listSkills(root: string): SkillInfo[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const name of entries.sort((a, b) => a.localeCompare(b))) {
    if (!NAME.test(name)) continue;
    const file = skillFile(root, name);
    if (!file) continue;
    out.push({ name, description: descriptionOf(readFileSync(file, "utf8")) });
  }
  return out;
}

/** Writes SKILL.md and any extra text files. One of the paths must be SKILL.md. */
export function importSkill(root: string, name: string, files: { path: string; text: string }[]): { name: string; files: string[] } {
  if (!files.length) throw new Error("no files");
  const normalized = files.map((f) => {
    const path = shown(f.path);
    return { path: path.startsWith(`${name}/`) ? path.slice(name.length + 1) : path, text: f.text };
  });
  if (!normalized.some((f) => f.path === "SKILL.md" || f.path === "skill.md")) throw new Error("the skill needs a SKILL.md");
  const written: string[] = [];
  for (const file of normalized) {
    if (file.path === "SKILL.md" || file.path === "skill.md") writeSkill(root, name, file.text);
    else writeSkillFile(root, name, file.path, file.text);
    written.push(file.path === "skill.md" ? "SKILL.md" : file.path);
  }
  return { name, files: written };
}

export function writeSkill(root: string, name: string, text: string): { name: string; path: string } {
  if (!NAME.test(name)) throw new Error("skill name must be letters, digits, dash or underscore");
  const body = text.trim();
  if (!body) throw new Error("skill text is empty");
  if (body.length > 100_000) throw new Error("skill text is longer than 100000 characters");
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  return { name, path: `${name}/SKILL.md` };
}

export function listSkillFiles(root: string, name: string): { name: string; files: string[] } {
  const dir = skillDir(root, name);
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) files.push(relative(dir, abs).split(sep).join("/"));
      if (files.length >= 200) return;
    }
  };
  try {
    walk(dir);
  } catch {
    throw new Error(`no skill ${name}`);
  }
  return { name, files: files.sort() };
}

export function readSkillFile(root: string, name: string, path: string): { name: string; path: string; text: string; truncated: boolean } {
  const abs = skillPath(root, name, path);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    throw new Error(`no file ${path} in skill ${name}`);
  }
  if (text.includes("\0")) throw new Error(`${path} is not a text file`);
  return { name, path: shown(path), text: text.slice(0, MAX_READ), truncated: text.length > MAX_READ };
}

export function writeSkillFile(root: string, name: string, path: string, text: string): { name: string; path: string } {
  const body = text;
  if (!body.trim()) throw new Error("file text is empty");
  if (body.length > 100_000) throw new Error("file is longer than 100000 characters");
  if (body.includes("\0")) throw new Error("only text files can be written");
  const abs = skillPath(root, name, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  return { name, path: shown(path) };
}

export function editSkillFile(root: string, name: string, path: string, old: string, replacement: string): { name: string; path: string } {
  if (!old) throw new Error("old text is empty");
  const abs = skillPath(root, name, path);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    throw new Error(`no file ${path} in skill ${name}`);
  }
  const hits = text.split(old).length - 1;
  if (hits !== 1) throw new Error(hits === 0 ? "old text was not found; read the file and copy a unique fragment" : `old text appears ${hits} times; include more surrounding lines`);
  const next = text.replace(old, replacement);
  if (next.length > 100_000) throw new Error("file would be longer than 100000 characters");
  writeFileSync(abs, next, "utf8");
  return { name, path: shown(path) };
}

export function readSkill(root: string, name: string): { name: string; text: string; truncated: boolean } {
  if (!NAME.test(name)) throw new Error("skill name must be letters, digits, dash or underscore");
  const file = skillFile(root, name);
  if (!file) throw new Error(`no skill ${name}`);
  const text = readFileSync(file, "utf8");
  return { name, text: text.slice(0, MAX_READ), truncated: text.length > MAX_READ };
}

export function skillCatalog(skills: SkillInfo[], limit = 60): string {
  const lines = [
    "Skills you can follow. skill.read loads SKILL.md. skill.files lists the other files. skill.read_file reads one of them.",
    "To change a skill, prefer skill.edit (one unique fragment). skill.write_file replaces or creates a whole file: a script, an instruction, or SKILL.md. skill.write replaces only SKILL.md.",
    "Do not invent steps that the skill does not contain.",
  ];
  if (!skills.length) {
    lines.push("(none)");
    return lines.join("\n");
  }
  for (const s of skills.slice(0, limit)) lines.push(`- ${s.name}: ${s.description || "no description"}`);
  if (skills.length > limit) lines.push(`- …${skills.length - limit} more; skill.read still works by name`);
  return lines.join("\n");
}

function skillDir(root: string, name: string): string {
  if (!NAME.test(name)) throw new Error("skill name must be letters, digits, dash or underscore");
  return resolve(root, name);
}

function shown(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function skillPath(root: string, name: string, path: string): string {
  const rel = shown(path);
  if (!rel || rel.startsWith("/") || rel.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("path must stay inside the skill folder");
  }
  const dir = skillDir(root, name);
  const abs = resolve(dir, rel);
  if (abs !== dir && !abs.startsWith(dir.endsWith(sep) ? dir : dir + sep)) throw new Error("path must stay inside the skill folder");
  return abs;
}

function skillFile(root: string, name: string): string | undefined {
  for (const file of [join(root, name, "SKILL.md"), join(root, name, "skill.md")]) {
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      /* missing */
    }
  }
  return undefined;
}

function descriptionOf(text: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (fm?.[1]) {
    const lines = fm[1].split(/\r?\n/);
    const at = lines.findIndex((l) => l.startsWith("description:"));
    if (at >= 0) {
      const rest = lines[at]!.slice("description:".length).trim();
      if (rest === ">" || rest === "|" || rest === "") {
        const block = [];
        for (const line of lines.slice(at + 1)) {
          if (!/^\s/.test(line)) break;
          block.push(line.trim());
        }
        if (block.length) return oneLine(block.join(" "));
      }
      return oneLine(rest.replace(/^["']|["']$/g, ""));
    }
  }
  const heading = text.split(/\r?\n/).find((l) => l.startsWith("# "));
  return oneLine(heading ? heading.slice(2) : "");
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 180 ? `${flat.slice(0, 177)}…` : flat;
}
