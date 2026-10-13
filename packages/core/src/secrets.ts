import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

  constructor(private readonly paths: SintyPaths) {
    this.key = loadOrCreateKey(paths.secretKey);
    if (existsSync(paths.secrets)) {
      const sealed = JSON.parse(readFileSync(paths.secrets, "utf8")) as Record<string, Sealed>;
      for (const [name, s] of Object.entries(sealed)) this.values.set(name, this.open(s));
    }
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
    const env = process.env[`SINTY_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
    return env ?? this.values.get(name);
  }

  set(name: string, value: string): void {
    this.values.set(name, value);
    this.persist();
  }

  delete(name: string): boolean {
    const had = this.values.delete(name);
    if (had) this.persist();
    return had;
  }

  names(): string[] {
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
    const env = Object.entries(process.env)
      .filter(([k]) => k.startsWith("SINTY_SECRET_"))
      .map(([, v]) => v ?? "");
    return [...this.values.values(), ...env];
  }

  private persist(): void {
    const sealed: Record<string, Sealed> = {};
    for (const [name, value] of this.values) sealed[name] = this.seal(value);
    writeFileSync(this.paths.secrets, JSON.stringify(sealed, null, 2), { mode: 0o600 });
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
