import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_ZIP = 20_000_000;
const MAX_FILES = 200;

export interface InstalledSkill {
  name: string;
  files: string[];
}

/** Folder or .zip. The skill is the directory that contains SKILL.md (Agent Skills layout). */
export function installSkillSource(skillsRoot: string, source: string): InstalledSkill {
  const abs = resolve(source);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    throw new Error(`нет такого пути: ${abs}`);
  }
  if (st.isDirectory()) return installDir(skillsRoot, abs);
  if (abs.toLowerCase().endsWith(".zip")) return installSkillZip(skillsRoot, readFileSync(abs));
  throw new Error("нужна папка навыка или файл .zip");
}

/** Files picked in the browser folder dialog. Paths keep the folder layout. */
export function installSkillFiles(skillsRoot: string, files: { path: string; data: Buffer }[]): InstalledSkill {
  if (!files.length) throw new Error("папка пустая");
  if (files.length > MAX_FILES) throw new Error("в навыке больше 200 файлов");
  const scratch = join(tmpdir(), `sinty-skill-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });
  try {
    for (const file of files) {
      const rel = file.path.replace(/\\/g, "/").replace(/^\/+/, "");
      if (!rel || rel.split("/").some((p) => !p || p === "." || p === "..")) throw new Error("путь выходит из папки");
      const dest = join(scratch, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.data);
    }
    return installDir(skillsRoot, findSkillDir(scratch));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function installSkillZip(skillsRoot: string, zip: Buffer): InstalledSkill {
  if (zip.length > MAX_ZIP) throw new Error("архив больше 20 МБ");
  const scratch = join(tmpdir(), `sinty-skill-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });
  try {
    for (const file of unzip(zip)) {
      const dest = join(scratch, file.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.data);
    }
    const skillDir = findSkillDir(scratch);
    return installDir(skillsRoot, skillDir);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function installDir(skillsRoot: string, dir: string): InstalledSkill {
  const skillDir = findSkillDir(dir);
  const text = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const name = skillName(text, skillDir);
  const dest = resolve(skillsRoot, name);
  const root = resolve(skillsRoot);
  if (dest !== root && !dest.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error("имя навыка выходит из папки skills");
  mkdirSync(dest, { recursive: true });
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        const rel = relative(skillDir, abs).split(sep).join("/");
        const target = join(dest, rel);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(abs, target);
        files.push(rel);
        if (files.length > MAX_FILES) throw new Error("в навыке больше 200 файлов");
      }
    }
  };
  walk(skillDir);
  if (!files.some((f) => f.toLowerCase() === "skill.md")) throw new Error("в папке нет SKILL.md");
  return { name, files: files.sort() };
}

function findSkillDir(dir: string): string {
  const direct = join(dir, "SKILL.md");
  try {
    if (statSync(direct).isFile()) return dir;
  } catch {
    /* look one level down */
  }
  const kids = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules");
  const hit = kids.find((e) => {
    try {
      return statSync(join(dir, e.name, "SKILL.md")).isFile();
    } catch {
      return false;
    }
  });
  if (!hit) throw new Error("в папке или архиве нет SKILL.md");
  return join(dir, hit.name);
}

function skillName(text: string, dir: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const line = fm?.[1]?.split(/\r?\n/).find((l) => l.startsWith("name:"));
  const raw = (line ? line.slice("name:".length) : dir.split(/[\\/]/).pop() ?? "").trim().replace(/^["']|["']$/g, "");
  const name = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!NAME.test(name)) throw new Error("имя навыка должно быть из латиницы, цифр, дефиса или подчёркивания");
  return name;
}

function unzip(zip: Buffer): { path: string; data: Buffer }[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("это не zip-архив");
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const out: { path: string; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("архив повреждён");
    const method = zip.readUInt16LE(offset + 10);
    const compSize = zip.readUInt32LE(offset + 20);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLen).toString("utf8").replace(/\\/g, "/");
    offset += 46 + nameLen + extraLen + commentLen;
    if (!name || name.endsWith("/")) continue;
    if (name.split("/").some((p) => p === ".." || p === ".")) throw new Error("архив содержит путь вне папки");
    const localNameLen = zip.readUInt16LE(local + 26);
    const localExtra = zip.readUInt16LE(local + 28);
    const start = local + 30 + localNameLen + localExtra;
    const compressed = zip.subarray(start, start + compSize);
    const data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
    if (!data) throw new Error(`сжатие zip ${method} не поддерживается`);
    out.push({ path: name, data });
    if (out.length > MAX_FILES) throw new Error("в архиве больше 200 файлов");
  }
  return out;
}
