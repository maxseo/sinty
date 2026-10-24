/**
 * Settings sections: a plugin declares `settings` in its manifest and the Web UI shows a section for it under
 * Settings (next to Основные / Модели / Плагины). Values live in config.yaml under `plugins.config.<plugin>`; the
 * manifest's `config` holds the defaults. The core's own sections (for example the supervisor) use the same format.
 * See docs/spec/plugin-manifest.md, "settings".
 */
export interface SettingsField {
  /** Dot path inside the section's config object, e.g. `keep` or `budget.tokens`. */
  key: string;
  label: string;
  type: "number" | "boolean" | "select" | "text";
  help?: string;
  /** Fields with the same group are shown together under this heading. */
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Numbers only: whole numbers. */
  integer?: boolean;
  /** May be left empty (the key is removed from config.yaml and the default or fallback applies). */
  optional?: boolean;
  /** `select` only. */
  options?: { value: string; label: string }[];
  unit?: string;
}

export interface SettingsSectionManifest {
  title: string;
  description?: string;
  fields: SettingsField[];
}

/** One section as `GET /v1/settings/sections` returns it. */
export interface SettingsSection extends SettingsSectionManifest {
  /** `supervisor` / `memory` / `policy` for core sections, `plugin.<name>` for a plugin's. */
  id: string;
  owner: "core" | "plugin";
  plugin?: string;
  /** Current values by field key (unset optional fields are absent). */
  values: Record<string, unknown>;
  /** Values used when a field is empty, by key, for placeholders. */
  defaults: Record<string, unknown>;
  /** Changes apply after `sinty web` restarts (plugins read their config at start). */
  restart: boolean;
  /** Which $SINTY_HOME file the section rewrites (`config.yaml` or `policy.yaml`). */
  store?: "config.yaml" | "policy.yaml";
}
