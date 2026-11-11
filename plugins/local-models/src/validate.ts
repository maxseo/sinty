import { CACHE_TYPES, type CacheType, type GpuLayers, type LaunchProfile } from "./types.js";

export function parseGpuLayers(raw: unknown): GpuLayers {
  if (raw === "auto" || raw === "all") return raw;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 10_000) return raw;
  if (typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw)) return Number(raw);
  throw new Error("число GPU-слоёв: целое ≥ 0, auto или all");
}

export function parseCacheType(raw: unknown, label: string): CacheType {
  if (typeof raw === "string" && (CACHE_TYPES as readonly string[]).includes(raw)) return raw as CacheType;
  throw new Error(`${label}: допустимы ${CACHE_TYPES.join(", ")}`);
}

export function parseCtxSize(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 1_048_576) throw new Error("контекст: целое от 0 до 1048576 (0 — как у модели)");
  return n;
}

export function parseParallel(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < -1 || n === 0 || n > 256) throw new Error("параллельность: -1 (auto) или 1–256");
  return n;
}

export function parsePort(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 65535) throw new Error("порт: 0 (свободный) или 1–65535");
  if (n > 0 && n < 1024) throw new Error("выберите порт 1024–65535 или 0");
  return n;
}

export function parseAlias(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("нужен идентификатор модели");
  const alias = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,80}$/.test(alias)) throw new Error("идентификатор модели: латиница, цифры, точка, :, +, -, _");
  return alias;
}

export function profileFields(input: Record<string, unknown>): Pick<LaunchProfile, "ctxSize" | "gpuLayers" | "cacheTypeK" | "cacheTypeV" | "parallel" | "port" | "host"> {
  return {
    ctxSize: parseCtxSize(input.ctxSize ?? 0),
    gpuLayers: parseGpuLayers(input.gpuLayers ?? "auto"),
    cacheTypeK: parseCacheType(input.cacheTypeK ?? "f16", "KV-кеш K"),
    cacheTypeV: parseCacheType(input.cacheTypeV ?? "f16", "KV-кеш V"),
    parallel: parseParallel(input.parallel ?? 1),
    port: parsePort(input.port ?? 0),
    host: "127.0.0.1",
  };
}

export function isAbsolutePath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith("/") && !p.startsWith("//")) return true;
  return /^[A-Za-z]:[\\/]/.test(p);
}
