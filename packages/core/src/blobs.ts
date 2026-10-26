import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BlobRef } from "@sinty/sdk";

const MAX_BYTES = 8_000_000;
const TEXT_CAP = 16_000;

export function saveBlob(dataDir: string, input: { bytes: Buffer; mime: string; name?: string }): BlobRef {
  if (input.bytes.length > MAX_BYTES) throw new Error(`file is larger than ${MAX_BYTES} bytes`);
  const hex = createHash("sha256").update(input.bytes).digest("hex");
  const dir = join(dataDir, "blobs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, hex);
  if (!existsSafe(file)) writeFileSync(file, input.bytes);
  const ref: BlobRef = { blob: `sha256:${hex}`, mime: input.mime || "application/octet-stream", bytes: input.bytes.length };
  if (input.name) ref.name = input.name.slice(0, 180);
  writeFileSync(`${file}.json`, JSON.stringify({ mime: ref.mime, name: ref.name ?? "" }));
  return ref;
}

export function readBlob(dataDir: string, ref: BlobRef): { bytes: Buffer; mime: string; name: string } | undefined {
  const hex = ref.blob.startsWith("sha256:") ? ref.blob.slice(7) : "";
  if (!/^[a-f0-9]{64}$/.test(hex)) return undefined;
  const file = join(dataDir, "blobs", hex);
  try {
    const bytes = readFileSync(file);
    let name = ref.name ?? "";
    let mime = ref.mime;
    try {
      const meta = JSON.parse(readFileSync(`${file}.json`, "utf8")) as { mime?: string; name?: string };
      name = name || meta.name || "";
      mime = mime || meta.mime || "application/octet-stream";
    } catch {
      /* meta is optional */
    }
    return { bytes, mime, name };
  } catch {
    return undefined;
  }
}

/** Text the model can read, or an image payload. Other bytes become a one-line note. */
export function renderAttachment(dataDir: string, ref: BlobRef): { text: string; image?: { mime: string; data: string } } {
  const file = readBlob(dataDir, ref);
  const label = ref.name || ref.blob;
  if (!file) return { text: `[вложение ${label} не найдено]` };
  if (file.mime.startsWith("image/")) {
    return { text: `[изображение ${label}, ${file.mime}, ${file.bytes.length} байт]`, image: { mime: file.mime, data: file.bytes.toString("base64") } };
  }
  const extracted = extractText(file.bytes, file.mime, file.name);
  if (extracted) return { text: `[файл ${label}]\n${extracted.slice(0, TEXT_CAP)}` };
  return { text: `[файл ${label}, ${file.mime}, ${file.bytes.length} байт — текст не извлечён]` };
}

function extractText(bytes: Buffer, mime: string, name: string): string {
  const lower = `${mime} ${name}`.toLowerCase();
  if (mime.startsWith("text/") || /\.(csv|tsv|md|json|txt|log)$/.test(name.toLowerCase())) return bytes.toString("utf8");
  if (lower.includes("pdf") || name.toLowerCase().endsWith(".pdf")) return pdfText(bytes);
  if (lower.includes("spreadsheet") || lower.includes("excel") || /\.xlsx$/.test(name.toLowerCase())) return xlsxText(bytes);
  return "";
}

function pdfText(bytes: Buffer): string {
  const chunks = [bytes.toString("latin1")];
  const src = bytes.toString("latin1");
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const raw = Buffer.from(m[1]!, "latin1");
    try {
      chunks.push(inflateRawSync(raw).toString("latin1"));
    } catch {
      chunks.push(raw.toString("latin1"));
    }
  }
  const texts: string[] = [];
  for (const chunk of chunks) {
    for (const hit of chunk.matchAll(/\((?:\\.|[^\\)]){1,400}\)\s*Tj/g)) {
      texts.push(unescapePdf(hit[0]!.slice(1, hit[0]!.lastIndexOf(")"))));
    }
  }
  return texts.join(" ").replace(/\s+/g, " ").trim();
}

function unescapePdf(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\r/g, "").replace(/\\t/g, "\t").replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
}

function xlsxText(bytes: Buffer): string {
  const files = unzip(bytes);
  const shared = [...(files.get("xl/sharedStrings.xml") ?? Buffer.alloc(0)).toString("utf8").matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1] ?? "");
  const lines: string[] = [];
  for (const [name, body] of files) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    const xml = body.toString("utf8");
    const row: string[] = [];
    for (const cell of xml.matchAll(/<c[^>]*?(?:t="([^"]+)")?[^>]*>[\s\S]*?<v>([^<]*)<\/v>/g)) {
      const kind = cell[1];
      const value = cell[2] ?? "";
      row.push(kind === "s" ? (shared[Number(value)] ?? "") : value);
    }
    if (row.length) lines.push(row.join("\t"));
  }
  return lines.join("\n");
}

function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (i + 30 < buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString("utf8");
    const start = i + 30 + nameLen + extra;
    const data = buf.subarray(start, start + compSize);
    let raw = data;
    if (method === 8) {
      try {
        raw = inflateRawSync(data);
      } catch {
        raw = Buffer.alloc(0);
      }
    }
    out.set(name, raw);
    i = start + compSize;
  }
  return out;
}

/** Write chat attachments into a project `_inbox` (or any dir). Blob store stays the model source of truth. */
export function materializeAttachmentsToDir(
  dataDir: string,
  destDir: string,
  refs: BlobRef[],
): { path: string; name: string }[] {
  mkdirSync(destDir, { recursive: true });
  const out: { path: string; name: string }[] = [];
  for (const ref of refs) {
    const file = readBlob(dataDir, ref);
    if (!file) continue;
    const base = safeFileName(file.name || ref.name || ref.blob.replace(/^sha256:/, "").slice(0, 12) || "file");
    const target = uniqueInboxPath(destDir, base, file.bytes);
    if (!target.skipped) writeFileSync(target.path, file.bytes);
    out.push({ path: target.path, name: target.name });
  }
  return out;
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "_").trim() || "file";
  return cleaned.slice(0, 180);
}

function uniqueInboxPath(dir: string, base: string, bytes: Buffer): { path: string; name: string; skipped?: boolean } {
  const first = join(dir, base);
  if (!existsSafe(first)) return { path: first, name: base };
  try {
    if (Buffer.compare(readFileSync(first), bytes) === 0) return { path: first, name: base, skipped: true };
  } catch {
    /* compare failed — write under a new name */
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const name = stem + "-" + i + ext;
    const path = join(dir, name);
    if (!existsSafe(path)) return { path, name };
    try {
      if (Buffer.compare(readFileSync(path), bytes) === 0) return { path, name, skipped: true };
    } catch {
      /* continue */
    }
  }
  const name = stem + "-" + createHash("sha256").update(bytes).digest("hex").slice(0, 8) + ext;
  return { path: join(dir, name), name };
}
function existsSafe(file: string): boolean {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}
