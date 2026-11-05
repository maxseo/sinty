/** Plugin settings from manifest config + config.yaml plugins.config.tool-listen. */
export interface ListenSettings {
  /** Empty → route "listen". */
  modelRoute: string;
  maxSeconds: number;
}

function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export function readSettings(config: Readonly<Record<string, unknown>>): ListenSettings {
  return {
    modelRoute: typeof config.modelRoute === "string" ? config.modelRoute.trim() : "",
    maxSeconds: Math.round(num(config.maxMinutes, 10, 1, 30) * 60),
  };
}
