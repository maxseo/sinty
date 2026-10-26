/**
 * Settings sections shown by the Web UI under Settings: the core's own (supervisor, memory, policy) and those
 * plugins declare in their manifest `settings`. Saving rewrites only the listed keys through a YAML document so
 * comments and the rest of the file stay as they are. Most sections write config.yaml; the policy section writes
 * policy.yaml (core-owned: tools cannot write it, the authenticated settings API may).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import type { SettingsField, SettingsSection, SettingsSectionManifest } from "@sinty/sdk";
import { effectiveBudget, loadConfig, loadPolicy, type SintyConfig, type SintyPolicy } from "./config.js";
import { DEFAULT_COMPACT_CAP } from "./context-window.js";
import type { SintyPaths } from "./paths.js";

const BUDGET = "Бюджет хода";
const CHECKS = "Проверки";
const LIMITS = "Пороги и эскалация";
const DEFAULTS = "По умолчанию";

const DECISION = [
  { value: "allow", label: "Разрешить" },
  { value: "ask", label: "Спрашивать" },
  { value: "deny", label: "Запретить" },
];

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
    { key: "maxNoticesPerDetector", label: "Заметок одной проверки за ход", type: "number", group: LIMITS, min: 1, max: 20, integer: true, help: "Отказы сайтов (401/403/404/429, 5xx, тайм-аут, слишком большая страница) идут отдельной проверкой «ошибка сайта» и ход не останавливают." },
    { key: "escalate", label: "Останавливать ход сверх лимитов", type: "boolean", group: LIMITS, help: "Выключено — лишние заметки просто не отправляются, цикл не останавливает ход." },
    { key: "useIncidents", label: "Подсказывать прошлые решения", type: "boolean", group: LIMITS, help: "Заметка об ошибке цитирует, как такая же ошибка была исправлена раньше." },
    { key: "docsMaxChars", label: "Документации инструмента в заметке", type: "number", group: LIMITS, min: 0, max: 20000, integer: true, unit: "симв.", help: "Раздел упавшего инструмента, один раз за ход. 0 — без документации." },
  ],
};

/** Caps that are not the per-turn supervisor budget: plugin side calls, the main reply, background children. */
export const LIMITS_SECTION: SettingsSectionManifest = {
  title: "Лимиты",
  description:
    "Потолки ядра вне бюджета одного хода. 0 у суточного лимита плагинов и у общего бюджета дерева — без ограничения. Суточные токены считаются по UTC и сбрасываются в 00:00 UTC. Значения действуют сразу.",
  fields: [
    {
      key: "models.pluginTokensPerDay",
      label: "Токенов плагина в сутки",
      type: "number",
      min: 0,
      step: 100000,
      integer: true,
      optional: true,
      unit: "ток.",
      help: "Сумма входа и выхода всех вызовов ctx.models одного плагина за сутки UTC. Сюда входит vision.look. Пусто — 2000000, 0 — без потолка.",
    },
    {
      key: "models.maxOutputTokens",
      label: "Токенов ответа основного хода",
      type: "number",
      min: 1,
      step: 1024,
      integer: true,
      unit: "ток.",
      help: "max_tokens основного хода. Боковой вызов плагина с собственным лимитом не может превысить это число.",
    },
    {
      key: "agent.taskMaxParallel",
      label: "Фоновых задач сразу",
      type: "number",
      min: 1,
      max: 32,
      integer: true,
      help: "Сколько agent.task с background: true могут идти под одним чатом.",
    },
    {
      key: "agent.taskTreeTokens",
      label: "Токенов на дерево задач",
      type: "number",
      min: 0,
      step: 100000,
      integer: true,
      unit: "ток.",
      help: "Общий потолок родителя и его детей. 0 — нет общего потолка, у каждого хода остаётся свой бюджет.",
    },
  ],
};

/** The core's memory section over config.yaml `memory:` (only the keys listed here). */
export const MEMORY_SECTION: SettingsSectionManifest = {
  title: "Память и контекст",
  description: "Когда длинный диалог сворачивается в сводку. Значения хранятся в config.yaml в разделе memory и действуют сразу.",
  fields: [
    {
      key: "compactCapTokens",
      label: "Потолок сводки, токенов",
      type: "number",
      min: 0,
      step: 10000,
      integer: true,
      optional: true,
      unit: "ток.",
      help:
        "Диалог сворачивается в сводку при 65% окна модели или при этом числе токенов — что наступит раньше. У моделей с окном 1M без потолка сводка была бы только на 650 тыс. токенов, и каждый шаг заново отправлял бы весь этот контекст. Пусто — 150000, 0 — без потолка (только 65% окна). Какой порог действует, видно на кольце во вкладке «Контекст».",
    },
  ],
};

/** The core's policy section over policy.yaml (defaults + mode). Tools/paths/net/agents stay out of v1 UI. */
export const POLICY_SECTION: SettingsSectionManifest = {
  title: "Политика",
  description:
    "Долгоживущие разрешения в policy.yaml. «Разрешить / спрашивать / запретить» — для инструментов без точного правила в tools:, по их sideEffects. «Не спрашивай» в чате, фраза вроде «не спрашивай» / just do it, remember на карточке и Allow all — только на эту сессию: пропускают ask, deny и чувствительные пути (.env, ключи) всё равно спрашивают. Карты tools:/paths:/net: и агенты — вручную в файле.",
  fields: [
    {
      key: "mode",
      label: "Режим",
      type: "select",
      options: [
        { value: "standard", label: "Обычный" },
        { value: "strict", label: "Строгий (shell только в sandbox)" },
      ],
      help: "strict на Linux: shell.run только через bubblewrap; если sandbox недоступен — отказ. Действует на следующие вызовы.",
    },
    {
      key: "defaults.none",
      label: "Без побочных эффектов (none)",
      type: "select",
      group: DEFAULTS,
      options: DECISION,
      help: "Типично: memory.recall, skill.*, list. Полный доступ ≈ allow на все четыре; спрашивать ≈ ask на write и external; только чтение ≈ deny на write и external.",
    },
    { key: "defaults.read", label: "Чтение (read)", type: "select", group: DEFAULTS, options: DECISION },
    { key: "defaults.write", label: "Запись (write)", type: "select", group: DEFAULTS, options: DECISION },
    { key: "defaults.external", label: "Внешнее (external)", type: "select", group: DEFAULTS, options: DECISION, help: "Сеть, shell, браузер и прочее с sideEffects: external." },
  ],
};

interface SectionDef {
  manifest: SettingsSectionManifest;
  owner: "core" | "plugin";
  plugin?: string;
  /** Where the section's object lives in the store file (empty = file root). */
  path: string[];
  /** Which $SINTY_HOME file this section rewrites. */
  store: "config" | "policy";
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
    store: "config",
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
  out.set("policy", {
    manifest: POLICY_SECTION,
    owner: "core",
    path: [],
    store: "policy",
    current: src.policy as unknown as Record<string, unknown>,
    defaults: {
      mode: "standard",
      "defaults.none": "allow",
      "defaults.read": "allow",
      "defaults.write": "ask",
      "defaults.external": "ask",
    },
    restart: false,
  });
  out.set("limits", {
    manifest: LIMITS_SECTION,
    owner: "core",
    path: [],
    store: "config",
    current: src.config as unknown as Record<string, unknown>,
    defaults: {
      "models.pluginTokensPerDay": 2_000_000,
      "models.maxOutputTokens": 8192,
      "agent.taskMaxParallel": 3,
      "agent.taskTreeTokens": 0,
    },
    restart: false,
  });
  out.set("memory", {
    manifest: MEMORY_SECTION,
    owner: "core",
    path: ["memory"],
    store: "config",
    current: src.config.memory as unknown as Record<string, unknown>,
    defaults: { compactCapTokens: DEFAULT_COMPACT_CAP },
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
    out.set(`plugin.${p.name}`, {
      manifest: p.settings,
      owner: "plugin",
      plugin: p.name,
      path: ["plugins", "config", p.name],
      store: "config",
      current: merge(p.config ?? {}, own),
      defaults,
      restart: true,
    });
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
    return {
      id,
      ...d.manifest,
      owner: d.owner,
      ...(d.plugin ? { plugin: d.plugin } : {}),
      values,
      defaults: d.defaults,
      restart: d.restart,
      store: d.store === "policy" ? "policy.yaml" : "config.yaml",
    };
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
 * Copies a loaded policy onto the live in-memory object (agent/host keep the same reference).
 */
export function assignPolicy(target: SintyPolicy, next: SintyPolicy): void {
  target.mode = next.mode;
  target.defaults = next.defaults;
  target.tools = next.tools;
  target.paths = next.paths;
  target.net = next.net;
  target.budgets = next.budgets;
  target.approvals = next.approvals;
  target.agents = next.agents;
}

/**
 * Writes the given fields of one section to config.yaml or policy.yaml and returns the reloaded values.
 * Unknown keys are rejected; a file the schema then refuses is put back as it was.
 */
export function saveSection(
  src: SectionSources,
  id: string,
  values: Record<string, unknown>,
): { config: SintyConfig; policy: SintyPolicy; restart: boolean; section: SettingsSection } {
  const d = defs(src).get(id);
  if (!d) throw new Error(`no settings section ${id}`);
  const fields = new Map(d.manifest.fields.map((f) => [f.key, f]));
  const filePath = d.store === "policy" ? src.paths.policy : src.paths.config;
  const before = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
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
  writeFileSync(filePath, String(doc));
  let config = src.config;
  let policy = src.policy;
  try {
    if (d.store === "policy") policy = loadPolicy(src.paths);
    else config = loadConfig(src.paths);
  } catch (e) {
    writeFileSync(filePath, before);
    throw e;
  }
  const section = listSections({ ...src, config, policy }).find((s) => s.id === id)!;
  return { config, policy, restart, section };
}
