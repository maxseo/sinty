/** Plugin settings (manifest config merged with config.yaml plugins.config.skills), clamped to sane ranges. */
export interface SkillsSettings {
  /** Skills listed in the prompt catalog; the rest stay readable by name. */
  catalogLimit: number;
}

export const DEFAULT_CATALOG_LIMIT = 60;

export function readSettings(config: Readonly<Record<string, unknown>>): SkillsSettings {
  const raw = typeof config.catalogLimit === "string" ? Number(config.catalogLimit) : config.catalogLimit;
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : DEFAULT_CATALOG_LIMIT;
  return { catalogLimit: Math.min(500, Math.max(1, n)) };
}
