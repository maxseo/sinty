import { writeFileSync } from "node:fs";

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
function str(s: string): Buffer {
  const data = Buffer.from(s, "utf8");
  return Buffer.concat([u64(data.length), data]);
}

/** Minimal GGUF with a few metadata keys and no tensors. */
export function writeGguf(path: string, meta: Record<string, string | number | boolean>): void {
  const entries = Object.entries(meta);
  const chunks: Buffer[] = [Buffer.from("GGUF"), u32(3), u64(0), u64(entries.length)];
  for (const [k, v] of entries) {
    chunks.push(str(k));
    if (typeof v === "string") {
      chunks.push(u32(8), str(v));
    } else if (typeof v === "boolean") {
      chunks.push(u32(7), Buffer.from([v ? 1 : 0]));
    } else {
      chunks.push(u32(4), u32(v));
    }
  }
  writeFileSync(path, Buffer.concat(chunks));
}
