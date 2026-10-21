import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { SintyPaths } from "./paths.js";

interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

const REF = /^secret:\/\/(.+)$/;

/** Encrypted secret store. Values are only ever handed to the core and to plugins that declare them. */
export class SecretStore {
  private readonly key: Buffer;
  private readonly values = new Map<string, string>();
  /** mtime and size of secrets.json as last read or written; another process's write changes them. */
  private stamp = "";

  constructor(private readonly paths: SintyPaths) {
    this.key = loadOrCreateKey(paths.secretKey);
    this.load();
  }

  /**
   * Re-reads secrets.json when another process (the CLI next to a running server: `sinty secret set`,
   * `sinty token rotate`) wrote it. Before this, a running server kept the values it started with, and its next write
   * put the old ones back. A file that cannot be read keeps the values in memory.
   */
  private refresh(): void {
    const now = fileStamp(this.paths.secrets);
    if (now === this.stamp) return;
    try {
      this.load();
    } catch {
      // A half-written file from another process: try again on the next read.
    }
  }

  private load(): void {
    const stamp = fileStamp(this.paths.secrets);
    const next = new Map<string, string>();
    if (existsSync(this.paths.secrets)) {
      const sealed = JSON.parse(readFileSync(this.paths.secrets, "utf8")) as Record<string, Sealed>;
      for (const [name, s] of Object.entries(sealed)) next.set(name, this.open(s));
    }
    this.values.clear();
    for (const [k, v] of next) this.values.set(k, v);
    this.stamp = stamp;
  }

  static isRef(value: unknown): value is string {
    return typeof value === "string" && REF.test(value);
  }

  /** `secret://name` → value; env `SINTY_SECRET_<NAME>` overrides the store. */
  resolve(ref: string | undefined): string | undefined {
    if (ref === undefined) return undefined;
    const m = REF.exec(ref);
    if (!m) return ref;
    return this.get(m[1]!);
  }

  get(name: string): string | undefined {
    this.refresh();
    const env = process.env[`SINTY_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
    return env ?? this.values.get(name);
  }

  set(name: string, value: string): void {
    this.refresh();
    this.values.set(name, value);
    this.persist();
  }

  delete(name: string): boolean {
    this.refresh();
    const had = this.values.delete(name);
    if (had) this.persist();
    return had;
  }

  names(): string[] {
    this.refresh();
    return [...this.values.keys()].sort();
  }

  /** Replaces every known secret value (≥ 6 chars) in a serialized payload. */
  redact(text: string): string {
    let out = text;
    for (const value of this.allValues()) {
      if (value.length >= 6) out = out.split(value).join("[redacted]");
    }
    return out;
  }

  private allValues(): string[] {
    this.refresh();
    const env = Object.entries(process.env)
      .filter(([k]) => k.startsWith("SINTY_SECRET_"))
      .map(([, v]) => v ?? "");
    return [...this.values.values(), ...env];
  }

  private persist(): void {
    const sealed: Record<string, Sealed> = {};
    for (const [name, value] of this.values) sealed[name] = this.seal(value);
    writeFileSync(this.paths.secrets, JSON.stringify(sealed, null, 2), { mode: 0o600 });
    this.stamp = fileStamp(this.paths.secrets);
  }

  private seal(value: string): Sealed {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  private open(s: Sealed): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(s.iv, "base64"));
    decipher.setAuthTag(Buffer.from(s.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(s.data, "base64")), decipher.final()]).toString("utf8");
  }
}

function loadOrCreateKey(file: string): Buffer {
  if (existsSync(file)) return Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  const key = randomBytes(32);
  writeFileSync(file, key.toString("base64"), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // chmod is a no-op on Windows; the file inherits the profile ACL.
  }
  return key;
}

function fileStamp(file: string): string {
  try {
    const st = statSync(file, { bigint: true });
    return `${st.mtimeNs}:${st.size}:${st.ino}`;
  } catch {
    return "";
  }
}
