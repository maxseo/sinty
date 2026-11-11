import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { IconGear } from "./icons.js";
import "./model-settings.css";

export type ModelProfile = { maxOutputTokens?: number; advanced?: true; [key: string]: number | string | boolean | undefined };
export type ModelProfiles = Record<string, ModelProfile>;
interface Controls { protocol: string; numericFields: string[]; reasoning: boolean; reasoningOff: boolean; thinkingBudget: boolean; cacheBreakpoints: boolean; cacheRoutingKey: boolean; modelSupport: "unknown" }
interface Metadata { generation: { maxOutputTokens: number; providers: Record<string, Controls> } }
const numeric: Record<string, { label: string; min: number; max: number; step: string }> = {
  temperature: { label: "Temperature", min: 0, max: 2, step: "any" },
  top_p: { label: "Top P", min: Number.MIN_VALUE, max: 1, step: "any" },
  top_k: { label: "Top K", min: 1, max: Number.MAX_SAFE_INTEGER, step: "1" },
  repeat_penalty: { label: "Repeat penalty (repeat_penalty)", min: Number.MIN_VALUE, max: 100, step: "any" },
  repetition_penalty: { label: "Repetition penalty (repetition_penalty)", min: Number.MIN_VALUE, max: 100, step: "any" },
  frequency_penalty: { label: "Frequency penalty", min: -2, max: 2, step: "any" },
  presence_penalty: { label: "Presence penalty", min: -2, max: 2, step: "any" },
};
const seed = (profile: ModelProfile = {}): Record<string, string> => Object.fromEntries(Object.entries(profile).map(([k, v]) => [k, String(v)]));

export function ModelSettings({ route, profiles, onChange }: { route: string; profiles: ModelProfiles; onChange: (profiles: ModelProfiles) => void }) {
  const [open, setOpen] = useState(false), [meta, setMeta] = useState<Metadata | undefined>(), [error, setError] = useState("");
  const [form, setForm] = useState<Record<string, string>>({}), [advanced, setAdvanced] = useState(false);
  const button = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); button.current?.focus(); };
  useEffect(() => { setOpen(false); setMeta(undefined); setError(""); }, [route]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    api<Metadata>("/v1/models").then(value => { if (active) setMeta(value); }).catch(e => { if (active) setError(String(e)); });
    dialog.current?.focus();
    return () => { active = false; };
  }, [open]);
  const controls = meta?.generation.providers[route.slice(0, route.indexOf("/"))];
  const set = (key: string, value: string) => setForm(current => ({ ...current, [key]: value }));
  const apply = () => {
    if (!controls || !meta) return;
    try {
      const profile: ModelProfile = {};
      const number = (key: string, min: number, max: number, integer = false): number | undefined => {
        const value = form[key]?.trim();
        if (!value) return undefined;
        const n = Number(value);
        if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isSafeInteger(n))) throw new Error("Недопустимое значение: " + key);
        return n;
      };
      const output = number("maxOutputTokens", 1, Number.MAX_SAFE_INTEGER, true);
      if (output !== undefined) profile.maxOutputTokens = output;
      if (advanced) {
        profile.advanced = true;
        for (const key of controls.numericFields) {
          const definition = numeric[key];
          if (!definition) continue;
          const value = number(key, definition.min, key === "temperature" && controls.protocol === "anthropic" ? 1 : definition.max, definition.step === "1");
          if (value !== undefined) profile[key] = value;
        }
        if (controls.reasoning && form.reasoningEffort) profile.reasoningEffort = form.reasoningEffort;
        if (controls.thinkingBudget) {
          const budget = number("thinkingBudgetTokens", 1024, Number.MAX_SAFE_INTEGER, true);
          if (budget !== undefined) {
            if (budget >= (output ?? meta.generation.maxOutputTokens)) throw new Error("Бюджет thinking должен быть меньше лимита ответа");
            if (["temperature", "top_p", "top_k"].some(k => profile[k] !== undefined)) throw new Error("Не сочетайте ручной sampling с включённым Anthropic thinking");
            profile.thinkingBudgetTokens = budget;
          }
        }
        if (controls.cacheBreakpoints) {
          if (form.promptCache) profile.promptCache = form.promptCache === "true";
          if (form.cacheTtl) profile.cacheTtl = form.cacheTtl;
          if (profile.promptCache === false && profile.cacheTtl) throw new Error("TTL неприменим при отключённых cache breakpoints");
        }
        if (controls.cacheRoutingKey && form.promptCacheKey) profile.promptCacheKey = form.promptCacheKey === "true";
        if (profile.repeat_penalty !== undefined && profile.repetition_penalty !== undefined) throw new Error("Выберите только одно имя repetition penalty для своего сервера");
      }
      const next = { ...profiles };
      if (Object.keys(profile).some(k => k !== "advanced")) next[route] = profile;
      else delete next[route];
      onChange(next); close();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const reset = () => { setForm({}); setAdvanced(false); setError(""); };
  const booleanSelect = (key: string, label: string) => <label class="field">{label}<select aria-label={label} value={form[key] ?? ""} onChange={e => set(key, e.currentTarget.value)}><option value="">Как у провайдера</option><option value="true">Да</option><option value="false">Нет</option></select></label>;
  return <>
    <button ref={button} type="button" class="ghost model-settings-gear" aria-label="Настройки выбранной модели" title="Настройки выбранной модели" disabled={!route} onClick={() => { setMeta(undefined); setForm(seed(profiles[route])); setAdvanced(profiles[route]?.advanced === true); setError(""); setOpen(true); }}><IconGear /></button>
    {open && <div class="overlay model-settings-overlay" onClick={close}>
      <div ref={dialog} class="dialog model-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="model-settings-title" tabIndex={-1} onClick={e => e.stopPropagation()} onKeyDown={e => {
        if (e.key === "Escape") { e.preventDefault(); close(); }
        if (e.key === "Tab") { const all = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)') ?? [])]; const first = all[0], last = all.at(-1); if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
      }}>
        <header class="dialog-head"><h3 id="model-settings-title">Настройки модели</h3><button type="button" class="ghost" aria-label="Закрыть настройки модели" onClick={close}>×</button></header>
        <p class="note model-settings-route">{route}</p>
        <p class="note">Только эта модель этого агента. Изменения вступят в силу после сохранения карточки. Служебные вызовы не затрагиваются.</p>
        {meta && controls ? <>
          <label class="field">Лимит токенов ответа<input aria-label="Лимит токенов ответа" type="number" min="1" step="1" value={form.maxOutputTokens ?? ""} placeholder={"Наследовать общий: " + meta.generation.maxOutputTokens} onInput={e => set("maxOutputTokens", e.currentTarget.value)} /></label>
          <p class="note">Пусто — текущий общий лимит Sinty ({meta.generation.maxOutputTokens}), в том числе после его изменения. Это не предел контекста сервера.</p>
          <label class="model-settings-advanced"><input type="checkbox" checked={advanced} onChange={e => setAdvanced(e.currentTarget.checked)} />Ручные расширенные параметры</label>
          <p class="note" role="note">Поддержка параметров этой моделью неизвестна. Поля ниже реализованы для протокола, но конкретная модель может их отклонить или проигнорировать. Включайте только подтверждённые для своего API параметры.</p>
          {advanced && <div class="model-settings-fields">
            {controls.numericFields.filter(key => numeric[key]).map(key => <label key={key} class="field">{numeric[key]!.label}<input aria-label={numeric[key]!.label} type="number" step={numeric[key]!.step} value={form[key] ?? ""} placeholder="Как у провайдера" onInput={e => set(key, e.currentTarget.value)} /></label>)}
            {controls.reasoning && <label class="field">Reasoning effort<select aria-label="Reasoning effort" value={form.reasoningEffort ?? ""} onChange={e => set("reasoningEffort", e.currentTarget.value)}><option value="">Как у провайдера</option>{controls.reasoningOff && <option value="off">off (DeepSeek API thinking disabled)</option>}{["low", "medium", "high"].map(v => <option value={v}>{v}</option>)}</select></label>}
            {!controls.reasoningOff && <p class="note">Универсальное отключение reasoning для этого endpoint не реализовано.</p>}
            {controls.thinkingBudget && <label class="field">Anthropic thinking budget<input aria-label="Anthropic thinking budget" type="number" min="1024" step="1" value={form.thinkingBudgetTokens ?? ""} placeholder="Как у провайдера" onInput={e => set("thinkingBudgetTokens", e.currentTarget.value)} /></label>}
            {controls.cacheBreakpoints && <>{booleanSelect("promptCache", "Anthropic cache breakpoints")}<label class="field">Anthropic cache TTL<select aria-label="Anthropic cache TTL" value={form.cacheTtl ?? ""} onChange={e => set("cacheTtl", e.currentTarget.value)}><option value="">Как у провайдера</option><option value="5m">5 минут</option><option value="1h">1 час (дороже запись)</option></select></label></>}
            {controls.cacheRoutingKey && <>{booleanSelect("promptCacheKey", "Передавать ключ маршрутизации prompt cache")}<p class="note">Отключение ключа не отключает автоматический кэш провайдера.</p></>}
          </div>}
        </> : !error && <p class="note">Загрузка настроек протокола…</p>}
        {error && <p class="error" role="alert">{error}</p>}
        <footer class="dialog-actions"><button type="button" class="ghost" onClick={reset}>Сбросить профиль</button><button type="button" class="ghost" onClick={close}>Отмена</button><button type="button" class="btn" disabled={!controls} onClick={apply}>Применить к карточке</button></footer>
      </div>
    </div>}
  </>;
}
