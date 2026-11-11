import { openSync, readSync, closeSync, statSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface GgufInfo {
  path: string;
  bytes: number;
  version: number;
  architecture?: string | undefined;
  name?: string | undefined;
  contextLength?: number | undefined;
  kind: "checkpoint" | "mmproj" | "unknown";
  reason?: string | undefined;
}

const MMPROJ_HINT = /mmproj|mm-proj|vision[-_]?proj|projector/i;
const SHARD = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

function u32(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}

function u64(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64LE(off);
}

function readExact(fd: number, len: number, cap = 8 * 1024 * 1024): Buffer {
  if (len < 0 || len > cap) throw new Error("метаданные GGUF слишком большие");
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, null);
    if (n <= 0) throw new Error("неполный файл GGUF");
    got += n;
  }
  return buf;
}

/**
 * Reads only the GGUF header and selected metadata. Does not load tensors.
 * A vision projector is never treated as a runnable checkpoint.
 */
export function inspectGguf(path: string): GgufInfo {
  const st = statSync(path);
  if (!st.isFile()) throw new Error("это не файл");
  const fd = openSync(path, "r");
  try {
    const head = readExact(fd, 24);
    if (head.subarray(0, 4).toString("utf8") !== "GGUF") throw new Error("файл не в формате GGUF");
    const version = u32(head, 4);
    if (version < 1 || version > 4) throw new Error(`неподдерживаемая версия GGUF (${version})`);
    const kvCount = Number(u64(head, 16));
    if (!Number.isFinite(kvCount) || kvCount < 0 || kvCount > 10_000) throw new Error("повреждённые метаданные GGUF");
    const meta: Record<string, string | number | boolean> = {};
    for (let i = 0; i < kvCount; i++) {
      const key = readGgufString(fd);
      const typ = u32(readExact(fd, 4), 0);
      const value = readGgufValue(fd, typ);
      if (key === "general.architecture" || key === "general.name" || key === "general.file_type" || key.endsWith(".context_length") || key.startsWith("clip.") || key.includes("projector")) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") meta[key] = value;
      }
    }
    const architecture = typeof meta["general.architecture"] === "string" ? String(meta["general.architecture"]) : undefined;
    const name = typeof meta["general.name"] === "string" ? String(meta["general.name"]) : undefined;
    const ctxKey = architecture ? `${architecture}.context_length` : undefined;
    const contextLength = ctxKey && typeof meta[ctxKey] === "number" ? Number(meta[ctxKey]) : undefined;
    const fileName = basename(path);
    const projector = architecture === "clip" || Object.keys(meta).some((k) => k.startsWith("clip.")) || MMPROJ_HINT.test(fileName) || MMPROJ_HINT.test(name ?? "");
    return {
      path,
      bytes: st.size,
      version,
      architecture,
      name,
      contextLength,
      kind: projector ? "mmproj" : architecture ? "checkpoint" : "unknown",
      ...(projector ? { reason: "это проектор (mmproj), а не основная модель" } : {}),
    };
  } finally {
    closeSync(fd);
  }
}

function readGgufString(fd: number): string {
  const len = Number(u64(readExact(fd, 8), 0));
  if (!Number.isFinite(len) || len < 0 || len > 1_000_000) throw new Error("повреждённая строка GGUF");
  return len ? readExact(fd, len).toString("utf8") : "";
}

function readGgufValue(fd: number, typ: number): unknown {
  // 0 uint8, 1 int8, 2 uint16, 3 int16, 4 uint32, 5 int32, 6 float32, 7 bool, 8 string, 9 array, 10 uint64, 11 int64, 12 float64
  switch (typ) {
    case 0:
    case 1:
      return readExact(fd, 1)[0];
    case 2:
    case 3:
      return readExact(fd, 2).readUInt16LE(0);
    case 4:
    case 5:
      return u32(readExact(fd, 4), 0);
    case 6:
      return readExact(fd, 4).readFloatLE(0);
    case 7:
      return readExact(fd, 1)[0] !== 0;
    case 8:
      return readGgufString(fd);
    case 10:
    case 11:
      return Number(u64(readExact(fd, 8), 0));
    case 12:
      return readExact(fd, 8).readDoubleLE(0);
    case 9: {
      const itemType = u32(readExact(fd, 4), 0);
      const count = Number(u64(readExact(fd, 8), 0));
      if (!Number.isFinite(count) || count < 0 || count > 100_000) throw new Error("повреждённый массив GGUF");
      for (let i = 0; i < count; i++) readGgufValue(fd, itemType);
      return [];
    }
    default:
      throw new Error(`неизвестный тип метаданных GGUF (${typ})`);
  }
}

export function parseShardName(name: string): { stem: string; index: number; total: number } | undefined {
  const m = SHARD.exec(name);
  if (!m) return undefined;
  return { stem: m[1]!, index: Number(m[2]), total: Number(m[3]) };
}

/** Sibling shards of a split GGUF in the same directory, including the given file. */
export function findSiblingShards(filePath: string): string[] | undefined {
  const name = basename(filePath);
  const parsed = parseShardName(name);
  if (!parsed) return undefined;
  const dir = dirname(filePath);
  const found: { index: number; path: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const p = parseShardName(entry);
    if (!p || p.stem !== parsed.stem || p.total !== parsed.total) continue;
    found.push({ index: p.index, path: join(dir, entry) });
  }
  found.sort((a, b) => a.index - b.index);
  if (found.length !== parsed.total) {
    throw new Error(`для разделённой модели нужно ${parsed.total} частей, найдено ${found.length}`);
  }
  for (let i = 0; i < found.length; i++) {
    if (found[i]!.index !== i + 1) throw new Error("части GGUF идут не по порядку или пропущены");
  }
  return found.map((f) => f.path);
}
