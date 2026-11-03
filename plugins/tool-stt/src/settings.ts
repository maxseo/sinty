/** Plugin settings from manifest config + config.yaml plugins.config.tool-stt. */
export interface SttSettings {
  /** Empty → route "stt". Otherwise that route name or provider/model. */
  modelRoute: string;
  maxBytes: number;
  /** ISO-639-1. Empty lets the model detect the language. */
  language: string;
}

function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export function readSettings(config: Readonly<Record<string, unknown>>): SttSettings {
  const language = typeof config.language === "string" ? config.language.trim().toLowerCase() : "";
  return {
    modelRoute: typeof config.modelRoute === "string" ? config.modelRoute.trim() : "",
    maxBytes: Math.round(num(config.maxAudioMb, 25, 1, 25) * 1_000_000),
    language: /^[a-z]{2}$/.test(language) ? language : "",
  };
}
