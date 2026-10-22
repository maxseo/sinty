import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Copies attached files into the project `_inbox` (or the workspace `_inbox`) under their own names. */
export function storeUploads(dataDir: string, inbox: string, refs: BlobRef[]): string[] {
  const saved: string[] = [];
  mkdirSync(inbox, { recursive: true });
  for (const ref of refs) {
    const file = readBlob(dataDir, ref);
    if (!file) continue;
    const base = (file.name || "file").replace(/[\\/:*?"<>|]/g, "_").slice(0, 180) || "file";
    let name = base;
    let n = 2;
    while (existsSync(join(inbox, name))) {
      const dot = base.lastIndexOf(".");
      name = dot > 0 ? `${base.slice(0, dot)}-${n}${base.slice(dot)}` : `${base}-${n}`;
      n += 1;
    }
    writeFileSync(join(inbox, name), file.bytes);
    saved.push(name);
  }
  return saved;
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
  if (lower.includes("wordprocessingml") || name.toLowerCase().endsWith(".docx")) return docxText(bytes);
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
    for (const rowXml of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row: string[] = [];
      for (const cell of rowXml[1]!.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const kind = /t="([^"]+)"/.exec(cell[1] ?? "")?.[1];
        const value = /<v>([^<]*)<\/v>/.exec(cell[2] ?? "")?.[1] ?? "";
        const inline = [...(cell[2] ?? "").matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1] ?? "").join("");
        row.push(kind === "s" ? (shared[Number(value)] ?? "") : inline || value);
      }
      if (row.length) lines.push(row.join("\t"));
    }
  }
  return lines.join("\n");
}

function docxText(bytes: Buffer): string {
  const xml = unzip(bytes).get("word/document.xml")?.toString("utf8") ?? "";
  return xml
    .replace(/<w:p\b[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function existsSafe(file: string): boolean {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}
