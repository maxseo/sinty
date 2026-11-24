import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { BlobRef } from "@sinty/sdk";
import { saveBlob } from "./blobs.js";

export const MCP_IMAGE_MAX = 4_000_000;
export const MCP_IMAGES_TOTAL_MAX = 8_000_000;
export const MCP_IMAGES_COUNT_MAX = 4;
const MIME = new Set(["image/png", "image/jpeg"]);

/** Header/dimension validation without decoding attacker-controlled images in the core. */
function validateImage(bytes: Buffer, mime: string): void {
  if (!MIME.has(mime) || !bytes.length || bytes.length > MCP_IMAGE_MAX) throw new Error("MCP image type or size is not supported");
  let width = 0, height = 0;
  if (mime === "image/png") {
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND") throw new Error("MCP image has an invalid PNG header");
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else {
    if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error("MCP image has an invalid JPEG header");
    const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let p = 2;
    while (p + 4 <= bytes.length) {
      if (bytes[p++] !== 255) break;
      let marker = bytes[p++]!;
      while (marker === 255 && p < bytes.length) marker = bytes[p++]!;
      if (marker === 0xda || marker === 0xd9 || p + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(p);
      if (length < 2 || p + length > bytes.length) throw new Error("MCP image has an invalid JPEG segment");
      if (sof.has(marker)) {
        if (length < 8) throw new Error("MCP image has an invalid JPEG frame");
        height = bytes.readUInt16BE(p + 3); width = bytes.readUInt16BE(p + 5); break;
      }
      p += length;
    }
  }
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16_000_000) throw new Error("MCP image dimensions exceed the supported limit");
}

/** Only standard inline MCP image blocks are read. Never resolve a URL, resource URI or file path. */
export function persistMcpImages(dataDir: string, content: unknown): { content: unknown; blobs?: BlobRef[] } {
  if (!content || typeof content !== "object" || !Array.isArray((content as { content?: unknown }).content)) return { content };
  const envelope = content as Record<string, unknown> & { content: unknown[] };
  const images: { index: number; bytes: Buffer; mime: string }[] = [];
  let total = 0;
  for (const [index, block] of envelope.content.entries()) {
    if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") continue;
    const { data, mimeType } = block as { data?: unknown; mimeType?: unknown };
    if (images.length >= MCP_IMAGES_COUNT_MAX || typeof data !== "string" || typeof mimeType !== "string" || !MIME.has(mimeType)) throw new Error("MCP inline image metadata is invalid or unsupported");
    if (!data.length || data.length > Math.ceil(MCP_IMAGE_MAX / 3) * 4 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("MCP image base64 is invalid or too large");
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data) throw new Error("MCP image base64 is not canonical");
    validateImage(bytes, mimeType); total += bytes.length;
    if (total > MCP_IMAGES_TOTAL_MAX) throw new Error("MCP image batch exceeds 8 MB");
    images.push({ index, bytes, mime: mimeType });
  }
  if (!images.length) return { content };
  // Validate the whole batch before storing any artifact.
  const blocks = [...envelope.content], blobs: BlobRef[] = [];
  for (const image of images) {
    const ref = saveBlob(dataDir, { bytes: image.bytes, mime: image.mime, name: `mcp-image-${blobs.length + 1}.${image.mime === "image/png" ? "png" : "jpg"}` });
    blobs.push(ref);
    blocks[image.index] = { type: "image", blob: ref.blob, mimeType: ref.mime, bytes: ref.bytes };
  }
  // Some MCP servers mirror image bytes in structuredContent or a text/rawJson field.
  // Normalize repetitions of these known inline payloads too, not arbitrary URLs/resources.
  const payloads = images.map((image, i) => ({ data: image.bytes.toString("base64"), blob: blobs[i]!.blob }));
  const normalized = JSON.stringify({ ...envelope, content: blocks }, (_key, value: unknown) => {
    if (typeof value !== "string") return value;
    for (const payload of payloads) value = (value as string).replaceAll(payload.data, payload.blob);
    return value;
  });
  return { content: JSON.parse(normalized), blobs };
}

/** Replay only bounded, content-addressed artifacts; ignore missing/modified/symlinked blobs safely. */
export function renderMcpImage(dataDir: string, ref: BlobRef): { mime: string; data: string } | undefined {
  if (!ref || typeof ref.blob !== "string" || !/^sha256:[a-f0-9]{64}$/.test(ref.blob) || !MIME.has(ref.mime) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > MCP_IMAGE_MAX) return undefined;
  try {
    const hex = ref.blob.slice(7), path = join(dataDir, "blobs", hex), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== ref.bytes) return undefined;
    // A fixed-size read also bounds allocation if the store file changes after lstat.
    const fd = openSync(path, "r");
    let bytes: Buffer;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size !== ref.bytes || opened.dev !== stat.dev || opened.ino !== stat.ino) return undefined;
      bytes = Buffer.alloc(ref.bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!n) return undefined;
        offset += n;
      }
      if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0) return undefined;
    } finally { closeSync(fd); }
    if (createHash("sha256").update(bytes).digest("hex") !== hex) return undefined;
    validateImage(bytes, ref.mime);
    return { mime: ref.mime, data: bytes.toString("base64") };
  } catch { return undefined; }
}
