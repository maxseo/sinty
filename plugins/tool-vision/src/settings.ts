/** Plugin settings from manifest config + config.yaml plugins.config.tool-vision. */
export interface VisionSettings {
  /** Empty → try route "vision", then "default". Otherwise that route name (must be allowed by permissions.models). */
  modelRoute: string;
  maxBytes: number;
  maxOutputTokens: number;
}

function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export function readSettings(config: Readonly<Record<string, unknown>>): VisionSettings {
  return {
    modelRoute: typeof config.modelRoute === "string" ? config.modelRoute.trim() : "",
    maxBytes: Math.round(num(config.maxImageMb, 8, 1, 8) * 1_000_000),
    maxOutputTokens: Math.round(num(config.maxOutputTokens, 1200, 100, 4000)),
  };
}
