/** Plugin settings from manifest config + config.yaml plugins.config.tool-vision. */
export interface VisionSettings {
  /** Empty → try route "vision", then "default". Otherwise that route name (must be allowed by permissions.models). */
  modelRoute: string;
  maxBytes: number;
  /** When false, a DeepSeek side call sends thinking disabled. The call never sets max_tokens. */
  reasoning: boolean;
  /** How many images share one model request. */
  batch: number;
}

function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export function readSettings(config: Readonly<Record<string, unknown>>): VisionSettings {
  return {
    modelRoute: typeof config.modelRoute === "string" ? config.modelRoute.trim() : "",
    maxBytes: Math.round(num(config.maxImageMb, 8, 1, 8) * 1_000_000),
    reasoning: config.reasoning === true,
    batch: Math.round(num(config.batch, 4, 1, 16)),
  };
}
