/**
 * Settings sections shown by the Web UI under Settings: the core's own (the supervisor) and those plugins declare in
 * their manifest `settings`. Every section is a flat list of fields over one object in config.yaml; saving rewrites
 * only those keys through a YAML document so comments and the rest of the file stay as they are.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import type { SettingsField, SettingsSection, SettingsSectionManifest } from "@sinty/sdk";
import { effectiveBudget, loadConfig, type SintyConfig, type SintyPolicy } from "./config.js";
import type { SintyPaths } from "./paths.js";

const BUDGET = "Бюджет хода";
const CHECKS = "Проверки";
const LIMITS = "Пороги и эскалация";

/** The core's supervisor section over config.yaml `supervisor:`. */
export const SUPERVISOR_SECTION: SettingsSectionManifest = {
  title: "Супервизор",
  description:
    "Супервизор следит за ходом агента: ошибки инструментов, циклы, бюджет, тишина. Значения хранятся в config.yaml в разделе supervisor. Пустое поле бюджета берётся из policy.yaml (budgets.turn), 0 — без ограничения.",
  fields: [
    { key: "enabled", label: "Супервизор включён", type: "boolean", help: "Выключение и включение действуют после перезапуска sinty web." },
    { key: "budget.tokens", label: "Токенов на ход", type: "number", group: BUDGET, min: 0, step: 10000, integer: true, optional: true },
    {
      key: "budget.count",
      label: "Как считать токены",
      type: "select",
      group: BUDGET,
      options: [
        { value: "weighted", label: "По цене: кэш со скидкой (рекомендуется)" },
        { value: "uncached", label: "Только некэшированные + ответ" },
        { value: "all", label: "Все токены запроса + ответ" },
      ],
      help: "С кэшем промпта длинный ход перечитывает один и тот же контекст: «все токены» быстро упираются в лимит, хотя стоит это мало. «По цене» считает кэшированные токены с весом ниже.",
    },
    { key: "budget.cachedWeight", label: "Вес кэшированного токена", type: "number", group: BUDGET, min: 0, max: 1, step: 0.05, help: "Для «по цене»: 0.1 ≈ скидка на чтение кэша у Anthropic, OpenAI и DeepSeek." },
    { key: "budget.steps", label: "Шагов модели на ход", type: "number", group: BUDGET, min: 0, integer: true, optional: true },
    { key: "budget.seconds", label: "Секунд на ход", type: "number", group: BUDGET, min: 0, integer: true, optional: true, unit: "с" },
    { key: "budget.warnAt", label: "Предупредить на доле бюджета", type: "number", group: BUDGET, min: 0.1, max: 1, step: 0.05, help: "0.8 — заметка агенту на 80% токенов или шагов." },
    { key: "budget.stop", label: "Останавливать ход по бюджету", type: "boolean", group: BUDGET, help: "Выключено — только предупреждение. После остановки ход продолжается кнопкой «Продолжить»." },
    { key: "checks.toolErrors", label: "Ошибки инструментов", type: "boolean", group: CHECKS },
    { key: "checks.loop", label: "Повторы одного вызова", type: "boolean", group: CHECKS },
    { key: "checks.budget", label: "Предупреждение о бюджете", type: "boolean", group: CHECKS },
    { key: "checks.badOutput", label: "Пустые и обрезанные ответы", type: "boolean", group: CHECKS },
    { key: "stallSeconds", label: "Секунд тишины до предупреждения", type: "number", group: CHECKS, min: 0, max: 3600, integer: true, unit: "с", help: "0 — не следить. У агента может быть свой порог." },
    { key: "stallBlock", label: "Останавливать зависший шаг", type: "boolean", group: CHECKS, help: "После двойной тишины шаг прерывается." },
    { key: "loopThreshold", label: "Одинаковых вызовов до заметки", type: "number", group: LIMITS, min: 1, max: 50, integer: true },
    { key: "loopBlockAfter", label: "Одинаковых вызовов до остановки", type: "number", group: LIMITS, min: 0, max: 100, integer: true, optional: true, help: "Пусто — порог заметки + 2. 0 — не останавливать." },
    { key: "repeatFailures", label: "Одинаковых ошибок до «не повторяй»", type: "number", group: LIMITS, min: 1, max: 20, integer: true },
    { key: "patchAfterTurns", label: "Ходов с ошибкой до предложения патча", type: "number", group: LIMITS, min: 0, max: 50, integer: true, help: "0 — не предлагать." },
    { key: "maxNoticesPerTurn", label: "Заметок за ход", type: "number", group: LIMITS, min: 1, max: 50, integer: true },
    { key: "maxNoticesPerDetector", label: "Заметок одной проверки за ход", type: "number", group: LIMITS, min: 1, max: 20, integer: true },
    { key: "escalate", label: "Останавливать ход сверх лимитов", type: "boolean", group: LIMITS, help: "Выключено — лишние заметки просто не отправляются, цикл не останавливает ход." },
    { key: "useIncidents", label: "Подсказывать прошлые решения", type: "boolean", group: LIMITS, help: "Заметка об ошибке цитирует, как такая же ошибка была исправлена раньше." },
    { key: "docsMaxChars", label: "Документации инструмента в заметке", type: "number", group: LIMITS, min: 0, max: 20000, integer: true, unit: "симв." },
  ],
};

interface SectionDef {
  manifest: SettingsSectionManifest;
  owner: "core" | "plugin";
  plugin?: string;
  /** Where the section's object lives in config.yaml. */
  path: string[];
  /** Current values (merged with defaults) as an object. */
  current: Record<string, unknown>;
  /** Values an empty field falls back to. */
  defaults: Record<string, unknown>;
  restart: boolean;
}

export interface SectionSources {
  paths: SintyPaths;
  config: SintyConfig;
  policy: SintyPolicy;
  plugins: { name: string; settings?: SettingsSectionManifest; config?: Record<string, unknown> }[];
}

function getPath(obj: unknown, key: string): unknown {
  let cur = obj;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function defs(src: SectionSources): Map<string, SectionDef> {
  const out = new Map<string, SectionDef>();
  const sup = src.config.supervisor as unknown as Record<string, unknown>;
  const budget = effectiveBudget(src.config, src.policy);
  const policyTurn = src.policy.budgets.turn;
  out.set("supervisor", {
    manifest: SUPERVISOR_SECTION,
    owner: "core",
    path: ["supervisor"],
    current: sup,
    defaults: {
      "budget.tokens": policyTurn.tokens ?? 0,
      "budget.steps": policyTurn.steps ?? 0,
      "budget.seconds": policyTurn.seconds ?? 0,
      loopBlockAfter: src.config.supervisor.loopThreshold + 2,
      "budget.count": budget.count,
    },
    restart: false,
  });
  for (const p of src.plugins) {
    if (!p.settings) continue;
    const own = src.config.plugins.config[p.name] ?? {};
    const defaults: Record<string, unknown> = {};
    for (const f of p.settings.fields) {
      const d = getPath(p.config ?? {}, f.key);
      if (d !== undefined) defaults[f.key] = d;
    }
    out.set(`plugin.${p.name}`, { manifest: p.settings, owner: "plugin", plugin: p.name, path: ["plugins", "config", p.name], current: merge(p.config ?? {}, own), defaults, restart: true });
  }
  return out;
}

function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) && v && typeof v === "object" && !Array.isArray(v) ? merge(b as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

export function listSections(src: SectionSources): SettingsSection[] {
  return [...defs(src)].map(([id, d]) => {
    const values: Record<string, unknown> = {};
    for (const f of d.manifest.fields) {
      const v = getPath(d.current, f.key);
      if (v !== undefined) values[f.key] = v;
    }
    return { id, ...d.manifest, owner: d.owner, ...(d.plugin ? { plugin: d.plugin } : {}), values, defaults: d.defaults, restart: d.restart };
  });
}

/** Checks one value against its field; `null` clears an optional field. */
export function checkField(f: SettingsField, v: unknown): unknown {
  if (v === null || v === "" || v === undefined) {
    if (f.optional) return null;
    throw new Error(`${f.label}: value is required`);
  }
  switch (f.type) {
    case "boolean":
      if (typeof v !== "boolean") throw new Error(`${f.label}: expected true or false`);
      return v;
    case "number": {
      const n = typeof v === "string" ? Number(v.trim()) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`${f.label}: expected a number`);
      if (f.integer && !Number.isInteger(n)) throw new Error(`${f.label}: expected a whole number`);
      if (f.min !== undefined && n < f.min) throw new Error(`${f.label}: at least ${f.min}`);
      if (f.max !== undefined && n > f.max) throw new Error(`${f.label}: at most ${f.max}`);
      return n;
    }
    case "select":
      if (typeof v !== "string" || !(f.options ?? []).some((o) => o.value === v)) throw new Error(`${f.label}: not one of the options`);
      return v;
    case "text":
      if (typeof v !== "string" || v.length > 10_000) throw new Error(`${f.label}: expected text up to 10000 characters`);
      return v;
  }
}

/**
 * Writes the given fields of one section to config.yaml and returns the reloaded config. Unknown keys are rejected; a
 * file the config schema then refuses is put back as it was.
 */
export function saveSection(src: SectionSources, id: string, values: Record<string, unknown>): { config: SintyConfig; restart: boolean; section: SettingsSection } {
  const d = defs(src).get(id);
  if (!d) throw new Error(`no settings section ${id}`);
  const fields = new Map(d.manifest.fields.map((f) => [f.key, f]));
  const before = existsSync(src.paths.config) ? readFileSync(src.paths.config, "utf8") : "";
  const doc = parseDocument(before);
  let restart = d.restart;
  for (const [key, raw] of Object.entries(values)) {
    const f = fields.get(key);
    if (!f) throw new Error(`unknown field ${key}`);
    const v = checkField(f, raw);
    const at = [...d.path, ...key.split(".")];
    if (v === null) doc.deleteIn(at);
    else doc.setIn(at, v);
    if (id === "supervisor" && key === "enabled" && v !== getPath(d.current, key)) restart = true;
  }
  writeFileSync(src.paths.config, String(doc));
  let config: SintyConfig;
  try {
    config = loadConfig(src.paths);
  } catch (e) {
    writeFileSync(src.paths.config, before);
    throw e;
  }
  const section = listSections({ ...src, config }).find((s) => s.id === id)!;
  return { config, restart, section };
}
