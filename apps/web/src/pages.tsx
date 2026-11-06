import { useEffect, useRef, useState } from "preact/hooks";
import { api, rotateToken, token } from "./api.js";
import { go, href } from "./route.js";
import { KitPage } from "./kit.js";
import { StaffPage } from "./staff.js";
import { SectionPane } from "./supervisor-ui.js";
import { useAccess } from "./access.js";

export function Denied() {
  return <div class="empty"><p>Этот раздел закрыт для вашей роли.</p></div>;
}

function useLoad<T>(path: string, deps: unknown[]): { data: T | undefined; error: string; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const reload = (): void => {
    if (!path) return;
    api<T>(path)
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(reload, deps);
  return { data, error, reload };
}

interface PluginInfo {
  name: string;
  version: string;
  description: string;
  kinds: string[];
  location: string;
  editable: boolean;
  disabled: boolean;
  tools: string[];
  routes: { method: string; path: string; public: boolean }[];
  ui: string | null;
  permissions: Record<string, unknown>;
  forAll?: boolean;
  defaultOn?: boolean;
  removable?: boolean;
}

interface SettingsPlugin {
  name: string;
  version: string;
  description: string;
  kinds: string[];
  enabled: boolean;
  removable?: boolean;
}

interface SettingsData {
  model: string;
  fallback: string[];
  providers: string[];
  agentsMd: string;
  serviceModel: string;
  compress: string;
  facts: string;
  stallSeconds: number;
  plugins: SettingsPlugin[];
}

function useInstallModel(): string {
  const { data } = useLoad<{ model: string }>("/v1/settings", []);
  return data?.model ?? "";
}

function useEnabledModels(): string[] {
  const { data } = useLoad<{ models: { route: string; enabled: boolean }[] }>("/v1/models", []);
  return (data?.models ?? []).filter((m) => m.enabled).map((m) => m.route);
}

function ModelSelect({ label, value, onChange, allowEmpty, variant }: { label: string; value: string; onChange: (v: string) => void; allowEmpty?: boolean; variant?: "native" | "cselect" }) {
  const routes = useEnabledModels();
  const shown = value.includes("/") ? value : "";
  const selected = routes.includes(shown) ? shown : "";
  if (variant === "cselect") {
    return (
      <label class="field">
        {label}
        <CSelect value={selected} onChange={onChange} options={routes.map((r) => ({ value: r, label: r }))} emptyLabel={allowEmpty ? "модель установки" : undefined} />
      </label>
    );
  }
  return (
    <label class="field">
      {label}
      <select value={selected} onChange={(e) => onChange(e.currentTarget.value)}>
        {allowEmpty && <option value="">модель установки</option>}
        {routes.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
    </label>
  );
}

function CSelect({ value, onChange, options, emptyLabel }: { value: string; onChange: (v: string) => void; options: { value: string; label: string; sub?: string }[]; emptyLabel?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    const timer = window.setTimeout(() => document.addEventListener("click", close), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("click", close);
    };
  }, [open]);
  const current = options.find((o) => o.value === value);
  const shown = current?.label || (value ? value : (emptyLabel || "—"));
  return (
    <div class={open ? "cselect open" : "cselect"} onClick={(e) => e.stopPropagation()}>
      <button type="button" class="cselect-btn" aria-haspopup="listbox" onClick={() => setOpen((v) => !v)}>
        <span class="cselect-val">{shown}</span>
        <svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4.2 6.2 8 10l3.8-3.8 1.2 1.2L8 12.4 3 7.4z"/></svg>
      </button>
      {open && (
        <div class="cselect-menu" role="listbox">
          {emptyLabel !== undefined && (
            <button type="button" class={!value ? "cselect-opt on" : "cselect-opt"} onClick={() => { onChange(""); setOpen(false); }}>{emptyLabel}</button>
          )}
          {options.map((o) => (
            <button key={o.value} type="button" class={o.value === value ? "cselect-opt on" : "cselect-opt"} onClick={() => { onChange(o.value); setOpen(false); }}>
              {o.label}
              {o.sub && <span class="sub">{o.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function modelShort(route: string): string {
  const i = route.lastIndexOf("/");
  return i >= 0 ? route.slice(i + 1) : route;
}

function FallbackPick({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const routes = useEnabledModels();
  const picked = value.split(/\s+/).filter(Boolean);
  return (
    <div class="field">
      Запасные
      <div class="chips">
        {routes.map((r) => {
          const on = picked.includes(r);
          return (
            <button key={r} type="button" class={on ? "chip on" : "chip"} onClick={() => onChange((on ? picked.filter((x) => x !== r) : [...picked, r]).join(" "))}>
              <i />
              {modelShort(r)}
            </button>
          );
        })}
      </div>
      {routes.length === 0 && <p class="small muted">Сначала включи модели в настройках.</p>}
    </div>
  );
}

function ProviderCard({ p, models, setProviders, setModels }: {
  p: { id: string; protocol: string; baseUrl: string; apiKey: string; hasKey: boolean };
  models: { route: string; enabled: boolean }[];
  setProviders: (fn: (cur: { id: string; protocol: string; baseUrl: string; apiKey: string; hasKey: boolean; remove?: boolean }[]) => { id: string; protocol: string; baseUrl: string; apiKey: string; hasKey: boolean; remove?: boolean }[]) => void;
  setModels: (fn: (cur: { route: string; enabled: boolean }[]) => { route: string; enabled: boolean }[]) => void;
}) {
  const [remote, setRemote] = useState<{ id: string; speech?: boolean }[]>([]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = (apiKey: string): void => {
    setBusy(true);
    setErr("");
    api<{ models: { id: string; speech?: boolean }[] }>("/v1/models/discover", { method: "POST", body: { id: p.id, baseUrl: p.baseUrl, protocol: p.protocol, apiKey } })
      .then((body) => { setRemote(body.models); setPicked([]); })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  useEffect(() => { if (p.hasKey) load(""); }, [p.id, p.hasKey]);
  const add = (): void => {
    setModels((cur) => {
      const next = [...cur];
      for (const id of picked) {
        const route = `${p.id}/${id}`;
        if (!next.some((m) => m.route === route)) next.push({ route, enabled: true });
      }
      return next;
    });
    setPicked([]);
  };
  return (
    <div class="panel provider-card">
      <div class="row"><b>{p.id}</b><span class="grow" /><button type="button" class="secondary sm" onClick={() => setProviders((cur) => cur.map((x) => (x.id === p.id ? { ...x, remove: true } : x)))}>Удалить</button></div>
      <label class="field">Адрес сервера<input value={p.baseUrl} onInput={(e) => setProviders((cur) => cur.map((x) => (x.id === p.id ? { ...x, baseUrl: e.currentTarget.value } : x)))} /></label>
      <label class="field">Ключ API<input type="password" value={p.apiKey || (p.hasKey ? "••••••••••••••••" : "")} placeholder="вставить ключ" onInput={(e) => { const raw = p.apiKey ? e.currentTarget.value : e.currentTarget.value.replace(/•/g, ""); setProviders((cur) => cur.map((x) => (x.id === p.id ? { ...x, apiKey: raw } : x))); }} onBlur={() => { if (p.apiKey.trim()) load(p.apiKey.trim()); }} /></label>
      {busy && <p class="small muted">Загрузка моделей…</p>}
      {err && <p class="error">{err}</p>}
      {remote.length > 0 && (
        <div>
          <label class="field">Найти модель<input value={query} placeholder="whisper" onInput={(e) => setQuery(e.currentTarget.value)} /></label>
          <div class="provider-models">
            {remote.filter((m) => m.id.toLowerCase().includes(query.trim().toLowerCase())).map((m) => {
              const have = models.some((row) => row.route === `${p.id}/${m.id}`);
              return (
                <label key={m.id} class="check">
                  <input type="checkbox" checked={have || picked.includes(m.id)} disabled={have} onChange={() => setPicked(picked.includes(m.id) ? picked.filter((x) => x !== m.id) : [...picked, m.id])} />
                  <span>{m.id}{m.speech && <span class="small muted"> распознавание</span>}{have && <span class="small muted"> уже в списке</span>}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
      <div class="provider-foot"><button type="button" disabled={picked.length === 0} onClick={add}>Добавить</button></div>
    </div>
  );
}

function ModelsPane({ model, setModel, saveInstall }: { model: string; setModel: (v: string) => void; saveInstall: () => Promise<void> }) {
  const { data, error, reload } = useLoad<{
    models: { route: string; enabled: boolean }[];
    providers: { id: string; protocol: string; baseUrl: string; hasKey: boolean }[];
    routes?: Record<string, string>;
    namedRouteKeys?: string[];
    serviceModel?: string;
  }>("/v1/models", []);
  const [models, setModels] = useState<{ route: string; enabled: boolean }[]>([]);
  const [providers, setProviders] = useState<{ id: string; protocol: string; baseUrl: string; apiKey: string; hasKey: boolean; remove?: boolean }[]>([]);
  const [namedRoutes, setNamedRoutes] = useState<Record<string, string>>({ cheap: "", embed: "", vision: "", stt: "", listen: "", long: "" });
  const [serviceModel, setServiceModel] = useState("");
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState({ id: "", name: "", baseUrl: "https://", protocol: "openai-compat", apiKey: "", models: [{ id: "", title: "" }] });
  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState("");
  const namedKeys = data?.namedRouteKeys?.length ? data.namedRouteKeys : ["cheap", "embed", "vision", "stt", "listen", "long"];
  const namedLabels: Record<string, string> = {
    cheap: "cheap — дешёвые/служебные вызовы плагинов",
    embed: "embed — эмбеддинги для памяти",
    vision: "vision — описание картинок",
    stt: "stt — распознавание речи",
    listen: "listen — разбор звука",
    long: "long — длинный контекст",
  };
  useEffect(() => {
    if (!data) return;
    setModels(data.models.filter((m) => m.enabled));
    setProviders(data.providers.map((p) => ({ id: p.id, protocol: p.protocol, baseUrl: p.baseUrl, apiKey: "", hasKey: p.hasKey })));
    const keys = data.namedRouteKeys?.length ? data.namedRouteKeys : ["cheap", "embed", "vision", "stt", "listen", "long"];
    const next: Record<string, string> = {};
    for (const k of keys) next[k] = data.routes?.[k] ?? "";
    setNamedRoutes(next);
    setServiceModel(data.serviceModel ?? "");
  }, [data]);
  const save = async (): Promise<void> => {
    setSaveError("");
    setNotice("");
    try {
      // saveInstall updates models.default; must not wipe fallback (omit fallback in PUT /v1/settings).
      await saveInstall();
      await api("/v1/models", {
        method: "PUT",
        body: {
          models,
          providers: providers.map((p) => ({ id: p.id, baseUrl: p.baseUrl, protocol: p.protocol, ...(p.remove ? { remove: true } : {}), ...(p.apiKey.trim() ? { apiKey: p.apiKey.trim() } : {}) })),
          routes: namedRoutes,
          serviceModel,
        },
      });
      setNotice("Сохранено. Каталог, маршруты и провайдеры обновятся сразу.");
      reload();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };
  const createProvider = (): void => {
    const id = draft.id.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]*$/.test(id) || providers.some((p) => p.id === id && !p.remove)) return;
    const rows = draft.models.map((m) => m.id.trim()).filter(Boolean).map((mid) => ({ route: `${id}/${mid}`, enabled: true }));
    setProviders([...providers, { id, protocol: draft.protocol, baseUrl: draft.baseUrl.trim(), apiKey: draft.apiKey, hasKey: false }]);
    setModels([...models, ...rows.filter((r) => !models.some((m) => m.route === r.route))]);
    setCustom(false);
    setDraft({ id: "", name: "", baseUrl: "https://", protocol: "openai-compat", apiKey: "", models: [{ id: "", title: "" }] });
  };
  return (
    <div class="settings-sheet">
      {error && <p class="error">{error}</p>}
      <h3>Модели</h3>
      <p class="small muted">Сверху модель установки. Ниже провайдеры и их ключи. Пустой ключ не затирает уже записанный.</p>
      <label class="field">Модель по умолчанию<input value={model} onInput={(e) => setModel(e.currentTarget.value)} placeholder="deepseek/deepseek-v4-pro" /></label>
      <h3>Именованные маршруты</h3>
      <p class="small muted">Ключи models.routes в config.yaml. Пустое значение снимает маршрут (плагин падает на default/service). Поля, которых нет в форме, при сохранении не затираются.</p>
      {namedKeys.map((key) => (
        <ModelSelect
          key={key}
          label={namedLabels[key] ?? key}
          value={namedRoutes[key] ?? ""}
          onChange={(v) => setNamedRoutes({ ...namedRoutes, [key]: v })}
          allowEmpty
        />
      ))}
      <ModelSelect label="Служебная (service.model) — сжатие/факты" value={serviceModel} onChange={setServiceModel} allowEmpty />
      <h3>Включённые модели</h3>
      <p class="small muted">Снятие галочки убирает модель из этого списка. В карточке провайдера её снова можно выбрать.</p>
      {models.filter((m) => providers.some((p) => !p.remove && m.route.startsWith(`${p.id}/`))).map((m) => (
        <label key={m.route} class="check">
          <input type="checkbox" checked onChange={() => setModels(models.filter((x) => x.route !== m.route))} />
          <span><b>{m.route}</b></span>
        </label>
      ))}
      <h3>Провайдеры</h3>
      {providers.filter((p) => !p.remove).map((p) => (
        <ProviderCard key={p.id} p={p} models={models} setProviders={setProviders} setModels={setModels} />
      ))}
      {custom ? (
        <div class="panel">
          <h3>Свой провайдер</h3>
          <label class="field">Идентификатор<input value={draft.id} placeholder="bai" onInput={(e) => setDraft({ ...draft, id: e.currentTarget.value })} /></label>
          <p class="small muted">Латиница с маленькой буквы. Так провайдер зовётся в маршруте и в секретнице.</p>
          <label class="field">Имя на экране<input value={draft.name} placeholder="bAI" onInput={(e) => setDraft({ ...draft, name: e.currentTarget.value })} /></label>
          <label class="field">Адрес сервера<input value={draft.baseUrl} onInput={(e) => setDraft({ ...draft, baseUrl: e.currentTarget.value })} /></label>
          <label class="field">Протокол
            <select value={draft.protocol} onChange={(e) => setDraft({ ...draft, protocol: e.currentTarget.value })}>
              <option value="openai-compat">openai-completions</option>
              <option value="openai-responses">openai-responses</option>
              <option value="anthropic">anthropic</option>
            </select>
          </label>
          <label class="field">Ключ API<input type="password" value={draft.apiKey} onInput={(e) => setDraft({ ...draft, apiKey: e.currentTarget.value })} /></label>
          <p class="small muted">Модели</p>
          {draft.models.map((m, i) => (
            <div class="row" key={i}>
              <input value={m.id} placeholder="id модели" onInput={(e) => setDraft({ ...draft, models: draft.models.map((x, n) => (n === i ? { ...x, id: e.currentTarget.value } : x)) })} />
              <input value={m.title} placeholder="имя на экране" onInput={(e) => setDraft({ ...draft, models: draft.models.map((x, n) => (n === i ? { ...x, title: e.currentTarget.value } : x)) })} />
            </div>
          ))}
          <button type="button" class="secondary" onClick={() => setDraft({ ...draft, models: [...draft.models, { id: "", title: "" }] })}>Добавить модель</button>
          <div class="row"><button type="button" class="secondary" onClick={() => setCustom(false)}>Отмена</button><button type="button" onClick={createProvider}>Создать провайдера</button></div>
        </div>
      ) : (
        <div class="row">
          <button type="button" class="secondary" onClick={() => { if (!providers.some((p) => p.id === "llama")) setProviders([...providers, { id: "llama", protocol: "openai-compat", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "", hasKey: false }]); }}>Добавить llama.cpp</button>
          <button type="button" class="secondary" onClick={() => { if (!providers.some((p) => p.id === "runninghub" && !p.remove)) setProviders([...providers, { id: "runninghub", protocol: "openai-compat", baseUrl: "https://llm.runninghub.ai/v1", apiKey: "", hasKey: false }]); }}>Добавить RunningHub</button>
          <button type="button" class="secondary" onClick={() => { if (!providers.some((p) => p.id === "openrouter" && !p.remove)) setProviders([...providers, { id: "openrouter", protocol: "openai-compat", baseUrl: "https://openrouter.ai/api/v1", apiKey: "", hasKey: false }]); }}>Добавить OpenRouter</button>
          <button type="button" class="secondary" onClick={() => setCustom(true)}>Добавить своего провайдера</button>
        </div>
      )}
      <div class="tool-actions"><button onClick={() => void save()}>Сохранить</button></div>
      {notice && <p class="small">{notice}</p>}
      {saveError && <p class="error">{saveError}</p>}
    </div>
  );
}

function GeneralPane() {
  const [prefs, setPrefs] = useState(() => {
    try { return { preset: "standard", language: "ru", appearance: localStorage.getItem("sinty.theme") || "system", enter: "queue", streaming: true, ...JSON.parse(localStorage.getItem("sinty.prefs") || "{}") }; }
    catch { return { preset: "standard", language: "ru", appearance: "system", enter: "queue", streaming: true }; }
  });
  const set = (patch: Partial<typeof prefs>): void => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    localStorage.setItem("sinty.prefs", JSON.stringify(next));
    if (patch.appearance) {
      const theme = patch.appearance === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : patch.appearance;
      document.documentElement.dataset.theme = theme;
      localStorage.setItem("sinty.theme", patch.appearance === "system" ? "" : theme);
    }
  };
  return (
    <div class="settings-sheet">
      <h3>Основные</h3>
      <label class="set-row">Пресет агента<span class="small muted">Для новых сессий</span>
        <select value={prefs.preset} onChange={(e) => set({ preset: e.currentTarget.value })}><option value="standard">Обычный</option><option value="careful">Осторожный</option></select>
      </label>
      <p class="set-row small muted">Разрешения по умолчанию (allow / ask / deny) — в разделе <a href={href({ page: "settings", section: "policy" })}>Политика</a>. «Не спрашивай» в чате действует только на эту сессию и не отменяет deny.</p>
      <label class="set-row">Язык
        <select value={prefs.language} onChange={(e) => set({ language: e.currentTarget.value })}><option value="ru">Русский</option><option value="en">English</option></select>
      </label>
      <div class="set-row">Оформление
        <div class="appear">
          {(["light", "dark", "system"] as const).map((id) => (
            <button type="button" key={id} class={prefs.appearance === id ? "secondary on" : "secondary"} onClick={() => set({ appearance: id })}>{id === "light" ? "Светлая" : id === "dark" ? "Тёмная" : "Как в системе"}</button>
          ))}
        </div>
      </div>
      <label class="set-row">Enter, пока агент занят
        <select value={prefs.enter} onChange={(e) => set({ enter: e.currentTarget.value })}><option value="queue">В очередь</option><option value="interrupt">Прервать</option></select>
      </label>
      <label class="set-row">Стриминг ответа<span class="small muted">Показывать текст по мере генерации</span>
        <input type="checkbox" checked={prefs.streaming !== false} onChange={(e) => set({ streaming: e.currentTarget.checked })} />
      </label>
      <TokenRow />
    </div>
  );
}

/** Login token rotation. The token itself is never shown: this tab keeps the new one, the link can be copied. */
function TokenRow() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [rotated, setRotated] = useState(false);
  const rotate = async (): Promise<void> => {
    if (!confirm("Сменить токен входа? Старый перестанет работать сразу: другие вкладки, устройства и скрипты попросят войти заново.")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await rotateToken();
      setRotated(true);
      setNotice("Токен сменён. Эта вкладка уже использует новый.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const copyLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(`${location.origin}${location.pathname}#token=${encodeURIComponent(token.get())}`);
      setNotice("Ссылка для входа скопирована. В ней токен: не отправляйте её посторонним.");
    } catch {
      setError("Не удалось скопировать. Новую ссылку покажет `sinty web`.");
    }
  };
  return (
    <div class="set-row">Токен входа<span class="small muted">Если ссылка или токен могли попасть к посторонним</span>
      <div class="row">
        <button type="button" class="secondary" disabled={busy} onClick={() => void rotate()}>{busy ? "Меняю…" : "Сменить токен входа"}</button>
        {rotated && <button type="button" class="ghost" onClick={() => void copyLink()}>Скопировать ссылку входа</button>}
      </div>
      {notice && <p class="small">{notice}</p>}
      {error && <p class="error">{error}</p>}
    </div>
  );
}

function PluginsSettings({
  enabled,
  setEnabled,
  catalog,
  model,
  onCatalogChange,
}: {
  enabled: string[];
  setEnabled: (v: string[]) => void;
  catalog: SettingsPlugin[];
  model: string;
  onCatalogChange: () => void;
}) {
  const { data, error, reload } = useLoad<{ plugins: PluginInfo[] }>("/v1/plugins", []);
  const [tab, setTab] = useState<"list" | "add">("list");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [localError, setLocalError] = useState("");
  const [path, setPath] = useState("");
  const [npm, setNpm] = useState("");
  const [replace, setReplace] = useState(false);
  const [drop, setDrop] = useState<string | null>(null);
  // Settings→Plugins must list the install catalog (incl. opt-in off plugins like scheduler)
  // and home installs. GET /v1/plugins only returns currently loaded plugins.enabled entries.
  const loaded = new Map((data?.plugins ?? []).map((p) => [p.name, p]));
  const all: PluginInfo[] = catalog.map((c) => {
    const p = loaded.get(c.name);
    return {
      name: c.name,
      version: p?.version || c.version,
      description: p?.description || c.description,
      kinds: p?.kinds?.length ? p.kinds : c.kinds,
      location: p?.location ?? (c.version ? "bundled" : "home"),
      editable: p?.editable ?? true,
      disabled: p?.disabled ?? !enabled.includes(c.name),
      tools: p?.tools ?? [],
      routes: p?.routes ?? [],
      ui: p?.ui ?? null,
      permissions: p?.permissions ?? {},
      forAll: p?.forAll,
      defaultOn: p?.defaultOn,
      removable: c.removable === true,
    };
  });
  for (const p of data?.plugins ?? []) {
    if (!all.some((x) => x.name === p.name)) all.push(p);
  }
  const rows = all.filter((p) => !q || p.name.includes(q) || p.description.toLowerCase().includes(q.toLowerCase()));

  const setShared = async (name: string, on: boolean): Promise<void> => {
    const names = (data?.plugins ?? []).filter((p) => (p.name === name ? on : p.forAll !== false)).map((p) => p.name);
    await api("/v1/plugins/shared", { method: "PUT", body: { names } });
    reload();
  };

  const setOn = async (name: string, on: boolean): Promise<void> => {
    setLocalError("");
    setNotice("");
    setBusy(true);
    try {
      const enabledNow = on ? [...new Set([...enabled, name])] : enabled.filter((n) => n !== name);
      const saved = await api<{ pluginErrors?: string[] }>("/v1/settings", { method: "PUT", body: { model, enabled: enabledNow } });
      setEnabled(enabledNow);
      if (saved.pluginErrors?.length) setLocalError(saved.pluginErrors.join(" "));
      setNotice(
        on
          ? "Включён. Вкладки и инструменты снова доступны. Прежние настройки на месте."
          : "Выключен. Вкладки и инструменты скрыты. Настройки и данные плагина сохранены.",
      );
      onCatalogChange();
      reload();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string): Promise<void> => {
    setLocalError("");
    setNotice("");
    setBusy(true);
    try {
      await api(`/v1/plugins/${encodeURIComponent(name)}`, { method: "DELETE" });
      setDrop(null);
      setEnabled(enabled.filter((n) => n !== name));
      setNotice(`Плагин ${name} удалён из библиотеки вместе с настройками и данными.`);
      onCatalogChange();
      reload();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const install = async (): Promise<void> => {
    setLocalError("");
    setNotice("");
    const body: Record<string, unknown> = { replace };
    if (path.trim()) body.path = path.trim();
    else if (npm.trim()) body.npm = npm.trim();
    else {
      setLocalError("Укажите путь к папке плагина или имя npm-пакета.");
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ name: string; started: boolean; next?: string; startError?: string }>("/v1/plugins/install", {
        method: "POST",
        body,
      });
      setNotice(result.startError ? `${result.next ?? "Установлен."} Старт: ${result.startError}` : (result.next ?? `Плагин ${result.name} установлен.`));
      setPath("");
      setNpm("");
      setTab("list");
      onCatalogChange();
      reload();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="settings-sheet">
      <h3>Плагины</h3>
      <p class="small muted">
        Список — все плагины харнеса (реестр установки и `$SINTY_HOME/plugins`), каждый можно включить или выключить.
        «Добавить» копирует локальную папку или npm-пакет с `sinty.plugin.json` в home-плагины. MCP — в разделе MCP.
      </p>
      <div class="tabs">
        <button type="button" class={tab === "list" ? "on" : ""} onClick={() => setTab("list")}>Установленные</button>
        <button type="button" class={tab === "add" ? "on" : ""} onClick={() => setTab("add")}>Добавить</button>
      </div>
      {(error || localError) && <p class="error">{error || localError}</p>}
      {notice && <p class="small">{notice}</p>}
      {drop && (
        <div class="overlay" onClick={() => { if (!busy) setDrop(null); }}>
          <div class="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Удалить {drop}?</h3>
            <p>Плагин будет стёрт из библиотеки. Его настройки и данные удалятся безвозвратно. Выключение этого не делает: при выключении всё сохраняется.</p>
            <footer class="dialog-actions">
              <button type="button" class="secondary" disabled={busy} onClick={() => setDrop(null)}>Отмена</button>
              <button type="button" class="danger" disabled={busy} onClick={() => void remove(drop)}>Удалить</button>
            </footer>
          </div>
        </div>
      )}
      {tab === "list" ? (
        <>
          <label class="search"><input placeholder="Поиск плагинов" value={q} onInput={(e) => setQ(e.currentTarget.value)} /></label>
          <div class="plugin-grid">
            {rows.map((p) => {
              const on = enabled.includes(p.name) || p.name === "ui-web";
              const everyone = p.forAll !== false;
              return (
                <div key={p.name} class={on ? "plugin-tile on" : "plugin-tile"}>
                  <div>
                    <b>{p.name}</b>
                    <div class="small muted">{p.version} · {p.location} · {(p.kinds ?? []).join(", ") || "—"}</div>
                    <div class="small">{p.description || "без описания"}</div>
                  </div>
                  <span class="tile-actions">
                    <button type="button" class={everyone ? "secondary sm" : "ghost sm"} disabled={busy || p.defaultOn} title={p.defaultOn ? "Встроенный плагин: есть у всех агентов, убрать можно в карточке агента" : undefined} onClick={() => void setShared(p.name, !everyone)}>{everyone ? "у всех" : "не у всех"}</button>
                    <button type="button" class={on ? "secondary sm" : "ghost sm"} disabled={busy || p.name === "ui-web"} onClick={() => void setOn(p.name, !on)}>{on ? "включён" : "выключен"}</button>
                    {p.removable && <button type="button" class="danger sm" disabled={busy} onClick={() => setDrop(p.name)}>Удалить</button>}
                  </span>
                </div>
              );
            })}
          </div>
          {rows.length === 0 && <p class="muted">Каталог пуст. Добавьте плагин вкладкой «Добавить».</p>}
        </>
      ) : (
        <section class="panel">
          <p class="small muted">
            Папка должна содержать sinty.plugin.json (и entry для runtime node). Копируется в каталог $SINTY_HOME/plugins, включается и hot-start через POST /v1/plugins/install.
            Для внешних MCP используйте Settings → MCP.
          </p>
          <label class="field">Путь к папке плагина
            <input value={path} placeholder="E:\plugins\my-tool" disabled={busy || Boolean(npm.trim())} onInput={(e) => setPath(e.currentTarget.value)} />
          </label>
          <label class="field">Или npm-пакет
            <input value={npm} placeholder="@scope/sinty-plugin-x" disabled={busy || Boolean(path.trim())} onInput={(e) => setNpm(e.currentTarget.value)} />
          </label>
          <label class="field row">
            <input type="checkbox" checked={replace} disabled={busy} onChange={(e) => setReplace(e.currentTarget.checked)} />
            <span>Заменить, если уже есть в home</span>
          </label>
          <button type="button" disabled={busy || (!path.trim() && !npm.trim())} onClick={() => void install()}>Установить</button>
        </section>
      )}
    </div>
  );
}

export function SettingsPage({ onSaved, section }: { onSaved: () => void; section: string }) {
  const { can } = useAccess();
  const { data, error, reload } = useLoad<SettingsData>(can("settings:general") || can("settings:models") || can("nav:plugins") ? "/v1/settings" : "", []);
  const [model, setModel] = useState("");
  const [enabled, setEnabled] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState("");
  useEffect(() => {
    if (!data) return;
    setModel(data.model);
    setEnabled(data.plugins.filter((p) => p.enabled).map((p) => p.name));
  }, [data]);
  const save = async (): Promise<void> => {
    setSaveError("");
    setNotice("");
    try {
      await api("/v1/settings", {
        method: "PUT",
        // Omit fallback so Models/Plugins saves do not wipe models.fallback.
        body: { model, enabled },
      });
      setNotice("Сохранено. Модель, персона и служебные задания действуют со следующего хода. Плагины подхватятся после перезапуска sinty web.");
      onSaved();
      reload();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section class="page settings-page">
      <h2>Настройки</h2>
      {error && <p class="error">{error}</p>}
      {!can(settingsResource(section)) ? <Denied /> : null}
      {section === "general" && can("settings:general") && <GeneralPane />}
      {section === "staff" && can("nav:staff") && <StaffPage />}
      {section === "uikit" && can("settings:uikit") && <KitPage />}
      {section !== "general" && section !== "models" && section !== "plugins" && section !== "uikit" && section !== "staff" && can(settingsResource(section)) && <SectionPane key={section} id={section} />}
      {section === "models" && can("settings:models") && <ModelsPane model={model} setModel={setModel} saveInstall={save} />}
      {section === "plugins" && can("nav:plugins") && data && (
        <PluginsSettings
          enabled={enabled}
          setEnabled={setEnabled}
          catalog={data.plugins}
          model={model}
          onCatalogChange={() => { onSaved(); reload(); }}
        />
      )}
    </section>
  );
}

/** Same mapping as the server (access-registry.ts): a plugin section is `ui:<plugin>/settings`, a core one `settings:<id>`. */
function settingsResource(section: string): string {
  if (section === "staff") return "nav:staff";
  if (section === "plugins") return "nav:plugins";
  if (section.startsWith("plugin.")) return `ui:${section.slice("plugin.".length)}/settings`;
  return `settings:${section}`;
}

interface AgentRecord {
  id: string;
  name: string;
  specialization: string;
  summary: string;
  avatar: string;
  persona: string;
  model: string;
  fallback: string;
  serviceModel: string;
  compress: string;
  facts: string;
  stallSeconds: number | null;
  skills: string[];
  /** Optional plugins; empty means the shared list. */
  plugins: string[];
  /** Default-on plugins (former core tools, e.g. tool-web) this agent goes without. */
  excludedPlugins: string[];
}

interface PluginRow {
  name: string;
  description: string;
  runtime?: string;
  forAll?: boolean;
  defaultOn?: boolean;
  disabled?: boolean;
}

const blankAgent = (): AgentRecord => ({
  id: "",
  name: "",
  specialization: "",
  summary: "",
  avatar: "",
  persona: "",
  model: "",
  fallback: "",
  serviceModel: "",
  compress: "",
  facts: "",
  stallSeconds: null,
  skills: [],
  plugins: [],
  excludedPlugins: [],
});

const AGENT_AVATAR_COLORS = ["#6366f1", "#0ea5e9", "#f97316", "#22c55e", "#eab308", "#ef4444", "#7c3aed", "#ec4899", "#06b6d4", "#8b5cf6"];

function agentLetter(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0]!.toUpperCase() : "?";
}

function agentHue(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = Math.imul(31, h) + name.charCodeAt(i) | 0;
  return AGENT_AVATAR_COLORS[Math.abs(h) % AGENT_AVATAR_COLORS.length]!;
}

export function AgentsPage({ agentId }: { agentId?: string }) {
  const agents = useLoad<{ agents: AgentRecord[] }>("/v1/roster/agents", []);
  const plugins = useLoad<{ plugins: PluginRow[] }>("/v1/plugins", []);
  const skills = useLoad<{ skills: { name: string; description: string }[]; disabled?: boolean }>("/v1/roster/skills", []);
  const installModel = useInstallModel();
  const [draft, setDraft] = useState<AgentRecord | undefined>();
  const [tab, setTab] = useState<"general" | "plugins" | "skills" | "mcp">("general");
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const saveAgentForm = async (): Promise<void> => {
    if (!draft?.name.trim()) return;
    setError("");
    try {
      const all = plugins.data?.plugins ?? [];
      const builtin = new Set(all.filter((p) => p.defaultOn).map((p) => p.name));
      const defaults = all.filter((p) => !p.defaultOn && p.forAll !== false).map((p) => p.name);
      const own = draft.model || installModel;
      const optional = draft.plugins.filter((n) => !builtin.has(n));
      const body = { ...draft, plugins: optional.length ? optional : defaults, excludedPlugins: (draft.excludedPlugins ?? []).filter((n) => builtin.has(n)), fallback: draft.fallback.trim() || own, serviceModel: draft.serviceModel.trim() || own, stallSeconds: draft.stallSeconds };
      const saved = draft.id
        ? await api<AgentRecord>(`/v1/roster/agents/${draft.id}`, { method: "PUT", body })
        : await api<AgentRecord>("/v1/roster/agents", { body });
      dispatchEvent(new Event("sinty-agents"));
      if (!draft.id) go({ page: "agents", agentId: saved.id });
      agents.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const rows = plugins.data?.plugins ?? [];
  const mcp = rows.filter((p) => p.runtime === "mcp-stdio" || p.runtime === "http");
  const tools = rows.filter((p) => p.runtime !== "mcp-stdio" && p.runtime !== "http");
  useEffect(() => {
    if (!agentId) {
      setDraft(undefined);
      return;
    }
    if (agentId === "new") {
      const defaults = (plugins.data?.plugins ?? []).filter((p) => !p.defaultOn && p.forAll !== false).map((p) => p.name);
      setDraft((cur) => (cur && cur.id === "" && cur.name.trim() ? cur : { ...blankAgent(), plugins: defaults }));
      return;
    }
    const found = agents.data?.agents.find((a) => a.id === agentId);
    if (found) setDraft(found);
  }, [agentId, agents.data, plugins.data]);
  const patch = (part: Partial<AgentRecord>): void => setDraft(draft ? { ...draft, ...part } : draft);
  // Default-on plugins (tool-web) are on for every agent unless its card excludes them; the rest follow the card's list.
  const builtin = rows.filter((p) => p.defaultOn).map((p) => p.name);
  const defaults = rows.filter((p) => !p.defaultOn && p.forAll !== false).map((p) => p.name);
  const optional = (draft?.plugins ?? []).filter((n) => !builtin.includes(n));
  const ownPicks = optional.length ? optional : defaults;
  const excluded = draft?.excludedPlugins ?? [];
  const chosen = [...ownPicks, ...builtin.filter((n) => !excluded.includes(n))];
  const togglePlugin = (name: string): void => {
    if (!draft) return;
    if (builtin.includes(name)) {
      patch({ excludedPlugins: excluded.includes(name) ? excluded.filter((n) => n !== name) : [...excluded, name] });
      return;
    }
    const has = ownPicks.includes(name);
    patch({ plugins: has ? ownPicks.filter((n) => n !== name) : [...ownPicks, name] });
  };
  const onAvatar = (file: File): void => {
    if (file.size > 200_000) {
      setError("Аватар больше 200 КБ");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => patch({ avatar: String(reader.result || "") });
    reader.readAsDataURL(file);
  };

  if (!draft) {
    return (
      <section class="page agent-page">
        <div class="agent-empty">
          <div class="agent-empty-av">?</div>
          <p>Выберите агента слева</p>
          <button type="button" onClick={() => go({ page: "agents", agentId: "new" })}>+ Новый агент</button>
          {error && <p class="error">{error}</p>}
        </div>
      </section>
    );
  }

  const letter = agentLetter(draft.name || draft.id || "?");
  const hue = agentHue(draft.name || draft.id || "?");
  const subtitle = [draft.specialization.trim(), draft.id ? "карточка агента" : "новый агент"].filter(Boolean).join(" · ");

  return (
    <section class="page agent-page">
      <header class="bar agent-bar">
        <span class="bar-av" style={draft.avatar ? undefined : { background: hue }}>
          {draft.avatar ? <img src={draft.avatar} alt="" /> : letter}
        </span>
        <div class="bar-meta">
          <b>{draft.name.trim() || "Новый агент"}</b>
          <span>{subtitle}</span>
        </div>
        <div class="tabs">
          {(["general", "plugins", "skills", "mcp"] as const).map((id) => (
            <button key={id} type="button" class={tab === id ? "on" : ""} onClick={() => setTab(id)}>
              {id === "general" ? "Общее" : id === "plugins" ? "Плагины" : id === "skills" ? "Навыки" : "MCP"}
            </button>
          ))}
        </div>
        <button type="button" class="agent-save" disabled={!draft.name.trim()} onClick={() => void saveAgentForm()}>Сохранить</button>
      </header>
      {error && <p class="error agent-page-error">{error}</p>}
      <div class="agent-sheet">
        {tab === "general" && (
          <div class="card">
            <div class="agent-section">
              <div class="section-h"><h3>Личность</h3></div>
              <div class="persona">
                <button type="button" class="ava-edit" style={draft.avatar ? undefined : { background: hue }} onClick={() => fileRef.current?.click()}>
                  {draft.avatar ? <img src={draft.avatar} alt="" /> : letter}
                  <span>сменить</span>
                </button>
                <input ref={fileRef} class="file-hidden" type="file" accept="image/*" onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) onAvatar(f); e.currentTarget.value = ""; }} />
                <div class="persona-fields">
                  <div class="grid-2">
                    <label class="field">Имя<input value={draft.name} onInput={(e) => patch({ name: e.currentTarget.value })} /></label>
                    <label class="field">Специализация<input value={draft.specialization} onInput={(e) => patch({ specialization: e.currentTarget.value })} /></label>
                  </div>
                  <label class="field">Краткое описание<textarea rows={2} value={draft.summary} onInput={(e) => patch({ summary: e.currentTarget.value })} /></label>
                </div>
              </div>
            </div>
            <div class="agent-section">
              <div class="section-h"><h3>Инструкция</h3></div>
              <div class="code-card">
                <div class="cap"><span>AGENTS.md</span><span>markdown</span></div>
                <textarea rows={8} value={draft.persona} onInput={(e) => patch({ persona: e.currentTarget.value })} />
              </div>
            </div>
            <div class="agent-section">
              <details class="acc" open>
                <summary>Модели</summary>
                <div class="body">
                  <ModelSelect variant="cselect" label="По умолчанию" value={draft.model} onChange={(model) => patch({ model, fallback: draft.fallback || model, serviceModel: draft.serviceModel || model })} allowEmpty />
                  <FallbackPick value={draft.fallback || draft.model || installModel} onChange={(fallback) => patch({ fallback })} />
                </div>
              </details>
            </div>
            <div class="agent-section">
              <details class="acc">
                <summary>Служебные вызовы</summary>
                <div class="body">
                  <ModelSelect variant="cselect" label="Модель для служебных вызовов" value={draft.serviceModel || draft.model || installModel} onChange={(serviceModel) => patch({ serviceModel })} />
                  <label class="field">Сжатие переписки<textarea rows={3} value={draft.compress} onInput={(e) => patch({ compress: e.currentTarget.value })} /></label>
                  <label class="field">Факты<textarea rows={3} value={draft.facts} onInput={(e) => patch({ facts: e.currentTarget.value })} /></label>
                  <label class="field">Таймаут хода, сек<input value={draft.stallSeconds ?? ""} placeholder="пусто — порог установки, 0 — не следить" onInput={(e) => { const v = e.currentTarget.value.trim(); patch({ stallSeconds: v === "" ? null : Number(v) }); }} /></label>
                </div>
              </details>
            </div>
            <p class="note">Проекты здесь не редактируются — состав агентов правится из карточки проекта в левой панели.</p>
          </div>
        )}
        {tab === "plugins" && (
          <div class="card">
            <div class="section-h"><h3>Плагины агента</h3></div>
            <AgentPluginTiles rows={tools} chosen={chosen} onToggle={togglePlugin} />
          </div>
        )}
        {tab === "mcp" && (
          <div class="card">
            <div class="section-h"><h3>MCP</h3></div>
            <AgentPluginTiles rows={mcp} chosen={chosen} onToggle={togglePlugin} empty="Подключённых MCP нет." />
            <p class="note">Пусто? Подключи MCP в Параметры, затем включи здесь тумблером.</p>
          </div>
        )}
        {tab === "skills" && (
          <div class="card">
            <div class="section-h"><h3>Навыки</h3></div>
            {skills.data?.disabled ? (
              <p class="muted small">Плагин skills выключен в настройках: каталога навыков и инструментов skill.* нет ни у одного агента.</p>
            ) : (
              <>
                <AgentPluginTiles
                  rows={skills.data?.skills ?? []}
                  chosen={draft.skills}
                  onToggle={(name) => patch({ skills: draft.skills.includes(name) ? draft.skills.filter((n) => n !== name) : [...draft.skills, name] })}
                  empty="В папке skills пока нет навыков."
                />
                {(draft.excludedPlugins ?? []).includes("skills") && <p class="note">Плагин skills убран у этого агента на вкладке «Плагины»: отмеченные навыки он не увидит.</p>}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function AgentPluginTiles({ rows, chosen, onToggle, empty }: { rows: { name: string; description: string; defaultOn?: boolean }[]; chosen: string[]; onToggle: (name: string) => void; empty?: string }) {
  if (!rows.length) return <p class="muted small">{empty || "Запущенных плагинов нет."}</p>;
  return (
    <div class="plugin-grid">
      {rows.map((p) => {
        const on = chosen.includes(p.name);
        return (
          <div key={p.name} class={on ? "plugin-tile on" : "plugin-tile"}>
            <div class="plugin-av">{agentLetter(p.name)}</div>
            <div class="plugin-txt">
              <b>{p.name}</b>
              <span>{p.description}{p.defaultOn ? " · встроенный, у всех агентов" : ""}</span>
            </div>
            <button type="button" class={on ? "tog on" : "tog"} aria-label={on ? "включён" : "выключен"} onClick={() => onToggle(p.name)}></button>
          </div>
        );
      })}
    </div>
  );
}
