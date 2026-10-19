import { useEffect, useState } from "preact/hooks";
import { api, shortTime, type Pending, type SintyEvent } from "./api.js";
import { go, href } from "./route.js";

function useLoad<T>(path: string, deps: unknown[]): { data: T | undefined; error: string; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const reload = (): void => {
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

export function PendingPage({ tick }: { tick: SintyEvent | undefined }) {
  const { data, error, reload } = useLoad<{ pending: Pending[] }>("/v1/pending", [tick]);
  const decide = async (p: Pending, callId: string, decision: "approve" | "deny"): Promise<void> => {
    await api(`/v1/sessions/${encodeURIComponent(p.sessionId)}/approvals/${encodeURIComponent(callId)}`, { body: { decision } });
    reload();
  };
  const reasons: Record<Pending["reason"], string> = { approval: "одобрение инструмента", ask_human: "вопрос агента", supervisor: "остановлен супервизором", budget: "исчерпан бюджет" };
  return (
    <section class="page">
      <h2>Журнал</h2>
      {error && <p class="error">{error}</p>}
      {data && !data.pending.length && <p class="muted">Ничего не ждёт человека.</p>}
      {data?.pending.map((p) => (
        <div key={p.turnId} class="panel">
          <div class="row">
            <a href={href({ page: "chat", sessionId: p.sessionId })}>{p.sessionId}</a>
            <span class="status blocked">{reasons[p.reason]}</span>
          </div>
          {p.detail && <p>{p.detail}</p>}
          {p.approvals.map((a) => (
            <div key={a.callId} class="tool approval">
              <div class="tool-head">
                <code>{a.tool}</code> <span class="muted small">{a.reason}</span>
              </div>
              <pre>{JSON.stringify(a.args, null, 2)}</pre>
              <div class="tool-actions">
                <button onClick={() => void decide(p, a.callId, "approve")}>Одобрить</button>
                <button class="danger" onClick={() => void decide(p, a.callId, "deny")}>
                  Отклонить
                </button>
              </div>
            </div>
          ))}
          {p.reason !== "approval" && (
            <p class="small muted">
              Ответьте в <a href={href({ page: "chat", sessionId: p.sessionId })}>чате</a>, чтобы продолжить.
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

interface SupervisorData {
  enabled: boolean;
  events: SintyEvent[];
  incidents: { id: string; tool: string; code: string; message: string; fixSummary: string; createdAt: string }[];
  patches: { id: string; plugin: string; sessionId: string; status: string; reason: string; files: string[]; permissionsChanged: boolean; commit: string | null; createdAt: string }[];
}

export function SupervisorPage({ tick }: { tick: SintyEvent | undefined }) {
  const relevant = tick && (tick.type.startsWith("supervisor.") || tick.type.startsWith("plugin.patch.")) ? tick : undefined;
  const { data, error } = useLoad<SupervisorData>("/v1/supervisor", [relevant]);
  return (
    <section class="page">
      <h2>
        Супервизор <span class={`status ${data?.enabled ? "running" : "idle"}`}>{data?.enabled ? "включён" : "выключен"}</span>
      </h2>
      {error && <p class="error">{error}</p>}
      <h3>Последние замечания</h3>
      {data && !data.events.length && <p class="muted">Пока замечаний нет.</p>}
      <table>
        <tbody>
          {data?.events.map((e) => {
            const d = e.data as Record<string, string>;
            return (
              <tr key={e.id}>
                <td class="small">{shortTime(e.ts)}</td>
                <td>
                  <code>{e.type.replace("supervisor.", "")}</code>
                </td>
                <td class="small">{d.detector ?? d.tool ?? ""}</td>
                <td>{d.text ?? d.reason ?? d.fixSummary ?? ""}</td>
                <td>
                  <a class="small" href={href({ page: "chat", sessionId: e.sessionId })}>
                    чат
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h3>Патчи плагинов</h3>
      {data && !data.patches.length && <p class="muted">Патчей не было.</p>}
      <table>
        <tbody>
          {data?.patches.map((p) => (
            <tr key={p.id}>
              <td class="small">{shortTime(p.createdAt)}</td>
              <td>
                <code>{p.plugin}</code>
              </td>
              <td>
                <span class={`status ${p.status}`}>{p.status}</span>
                {p.permissionsChanged && <span class="status blocked">права</span>}
              </td>
              <td>{p.reason}</td>
              <td class="small muted">{p.files.join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Память инцидентов</h3>
      {data && !data.incidents.length && <p class="muted">Решённых инцидентов пока нет.</p>}
      <table>
        <tbody>
          {data?.incidents.map((i) => (
            <tr key={i.id}>
              <td class="small">{shortTime(i.createdAt)}</td>
              <td>
                <code>{i.tool}</code> <span class="small muted">{i.code}</span>
              </td>
              <td class="small">{i.message}</td>
              <td>{i.fixSummary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
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
}

interface SettingsPlugin {
  name: string;
  version: string;
  description: string;
  kinds: string[];
  enabled: boolean;
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

function ModelSelect({ label, value, onChange, allowEmpty }: { label: string; value: string; onChange: (v: string) => void; allowEmpty?: boolean }) {
  const routes = useEnabledModels();
  const shown = value.includes("/") ? value : "";
  return (
    <label class="field">
      {label}
      <select value={routes.includes(shown) ? shown : ""} onChange={(e) => onChange(e.currentTarget.value)}>
        {allowEmpty && <option value="">модель установки</option>}
        {routes.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
    </label>
  );
}

function FallbackPick({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const routes = useEnabledModels();
  const picked = value.split(/\s+/).filter(Boolean);
  return (
    <div class="field">
      Запасные модели
      {routes.map((r) => (
        <label key={r} class="check">
          <input type="checkbox" checked={picked.includes(r)} onChange={() => onChange((picked.includes(r) ? picked.filter((x) => x !== r) : [...picked, r]).join(" "))} />
          {r}
        </label>
      ))}
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
  const [remote, setRemote] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = (apiKey: string): void => {
    setBusy(true);
    setErr("");
    api<{ models: { id: string }[] }>("/v1/models/discover", { method: "POST", body: { id: p.id, baseUrl: p.baseUrl, protocol: p.protocol, apiKey } })
      .then((body) => { setRemote(body.models.map((m) => m.id)); setPicked([]); })
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
        <div class="provider-models">
          {remote.map((id) => {
            const have = models.some((m) => m.route === `${p.id}/${id}`);
            return (
              <label key={id} class="check">
                <input type="checkbox" checked={have || picked.includes(id)} disabled={have} onChange={() => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id])} />
                <span>{id}{have && <span class="small muted"> уже в списке</span>}</span>
              </label>
            );
          })}
        </div>
      )}
      <div class="provider-foot"><button type="button" disabled={picked.length === 0} onClick={add}>Добавить</button></div>
    </div>
  );
}

function ModelsPane({ model, setModel, saveInstall }: { model: string; setModel: (v: string) => void; saveInstall: () => Promise<void> }) {
  const { data, error, reload } = useLoad<{ models: { route: string; enabled: boolean }[]; providers: { id: string; protocol: string; baseUrl: string; hasKey: boolean }[] }>("/v1/models", []);
  const [models, setModels] = useState<{ route: string; enabled: boolean }[]>([]);
  const [providers, setProviders] = useState<{ id: string; protocol: string; baseUrl: string; apiKey: string; hasKey: boolean; remove?: boolean }[]>([]);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState({ id: "", name: "", baseUrl: "https://", protocol: "openai-compat", apiKey: "", models: [{ id: "", title: "" }] });
  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState("");
  useEffect(() => {
    if (!data) return;
    setModels(data.models.filter((m) => m.enabled));
    setProviders(data.providers.map((p) => ({ id: p.id, protocol: p.protocol, baseUrl: p.baseUrl, apiKey: "", hasKey: p.hasKey })));
  }, [data]);
  const save = async (): Promise<void> => {
    setSaveError("");
    setNotice("");
    try {
      await saveInstall();
      await api("/v1/models", { method: "PUT", body: { models, providers: providers.map((p) => ({ id: p.id, baseUrl: p.baseUrl, protocol: p.protocol, ...(p.remove ? { remove: true } : {}), ...(p.apiKey.trim() ? { apiKey: p.apiKey.trim() } : {}) })) } });
      setNotice("Сохранено. Списки у агентов обновятся сразу.");
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
      <h3>Включённые маршруты</h3>
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
    try { return { preset: "standard", permission: "full", language: "ru", appearance: localStorage.getItem("sinty.theme") || "system", enter: "queue", ...JSON.parse(localStorage.getItem("sinty.prefs") || "{}") }; }
    catch { return { preset: "standard", permission: "full", language: "ru", appearance: "system", enter: "queue" }; }
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
      <label class="set-row">Доступ
        <select value={prefs.permission} onChange={(e) => set({ permission: e.currentTarget.value })}><option value="full">Полный</option><option value="ask">Спрашивать</option><option value="read">Только чтение</option></select>
      </label>
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
    </div>
  );
}

function PluginsSettings({ enabled, setEnabled }: { enabled: string[]; setEnabled: (v: string[]) => void }) {
  const { data, error, reload } = useLoad<{ plugins: PluginInfo[] }>("/v1/plugins", []);
  const [tab, setTab] = useState<"config" | "list">("config");
  const [q, setQ] = useState("");
  const rows = (data?.plugins ?? []).filter((p) => !q || p.name.includes(q) || p.description.toLowerCase().includes(q.toLowerCase()));
  const setShared = async (name: string, on: boolean): Promise<void> => {
    const names = (data?.plugins ?? []).filter((p) => (p.name === name ? on : p.forAll !== false)).map((p) => p.name);
    await api("/v1/plugins/shared", { method: "PUT", body: { names } });
    reload();
  };
  return (
    <div class="settings-sheet">
      <h3>Плагины</h3>
      <p class="small muted">Настройка показывает, что умеет плагин. «У всех» включает его новому агенту сразу. В карточке агента этот набор можно изменить.</p>
      <div class="tabs">
        <button type="button" class={tab === "config" ? "on" : ""} onClick={() => setTab("config")}>Настройка</button>
        <button type="button" class={tab === "list" ? "on" : ""} onClick={() => setTab("list")}>Список</button>
      </div>
      {error && <p class="error">{error}</p>}
      {tab === "config" ? (data?.plugins ?? []).map((p) => (
        <details key={p.name} class="panel">
          <summary>
            <b>{p.name}</b> <span class="muted small">{p.version}</span>
            <span class="small muted"> {p.kinds.join(", ")}</span>
            <div class="small">{p.description}</div>
          </summary>
          {p.tools.length > 0 && <p class="small">Инструменты: {p.tools.map((t) => <code key={t}>{t} </code>)}</p>}
          {p.routes.length > 0 && <p class="small">HTTP: {p.routes.map((r) => <code key={r.method + r.path}>{`${r.method} ${r.path}${r.public ? " (public)" : ""} `}</code>)}</p>}
          <pre class="small">{JSON.stringify(p.permissions, null, 2)}</pre>
        </details>
      )) : (
        <>
          <label class="search"><input placeholder="Поиск плагинов" value={q} onInput={(e) => setQ(e.currentTarget.value)} /></label>
          <div class="plugin-grid">
            {rows.map((p) => {
              const on = enabled.includes(p.name) || p.name === "ui-web";
              const everyone = p.forAll !== false;
              return (
                <div key={p.name} class="plugin-tile">
                  <b>{p.name}</b>
                  <span class="tile-actions">
                    <button type="button" class={everyone ? "secondary sm" : "ghost sm"} onClick={() => void setShared(p.name, !everyone)}>{everyone ? "у всех" : "не у всех"}</button>
                    <button type="button" class={on ? "secondary sm" : "ghost sm"} disabled={p.name === "ui-web"} onClick={() => setEnabled(on ? enabled.filter((n) => n !== p.name) : [...enabled, p.name])}>{on ? "включён" : "выключен"}</button>
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export function SettingsPage({ onSaved, section }: { onSaved: () => void; section: "general" | "models" | "plugins" }) {
  const { data, error, reload } = useLoad<SettingsData>("/v1/settings", []);
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
        body: { model, fallback: [], enabled },
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
      {section === "general" && <GeneralPane />}
      {section === "models" && <ModelsPane model={model} setModel={setModel} saveInstall={save} />}
      {section === "plugins" && data && (
        <>
          <PluginsSettings enabled={enabled} setEnabled={setEnabled} />
          <div class="settings-sheet"><button onClick={() => void save()}>Сохранить список</button>{notice && <p class="small">{notice}</p>}{saveError && <p class="error">{saveError}</p>}</div>
        </>
      )}
    </section>
  );
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
  plugins: string[];
}

interface PluginRow {
  name: string;
  description: string;
  runtime?: string;
  forAll?: boolean;
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
});

interface ProjectRecord {
  id: string;
  name: string;
  leadId: string;
  agentIds: string[];
}

export function AgentsPage({ agentId }: { agentId?: string }) {
  const agents = useLoad<{ agents: AgentRecord[] }>("/v1/roster/agents", []);
  const projects = useLoad<{ projects: ProjectRecord[] }>("/v1/roster/projects", []);
  const plugins = useLoad<{ plugins: PluginRow[] }>("/v1/plugins", []);
  const skills = useLoad<{ skills: { name: string; description: string }[] }>("/v1/roster/skills", []);
  const installModel = useInstallModel();
  const [draft, setDraft] = useState<AgentRecord | undefined>();
  const [tab, setTab] = useState<"general" | "plugins" | "skills" | "mcp">("general");
  const [projectName, setProjectName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [lead, setLead] = useState("");
  const [error, setError] = useState("");

  const saveAgentForm = async (): Promise<void> => {
    if (!draft?.name.trim()) return;
    setError("");
    try {
      const defaults = (plugins.data?.plugins ?? []).filter((p) => p.forAll !== false).map((p) => p.name);
      const own = draft.model || installModel;
      const body = { ...draft, plugins: draft.plugins.length ? draft.plugins : defaults, fallback: draft.fallback.trim() || own, serviceModel: draft.serviceModel.trim() || own, stallSeconds: draft.stallSeconds };
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

  const saveProject = async (): Promise<void> => {
    setError("");
    try {
      await api("/v1/roster/projects", { body: { name: projectName, agentIds: picked, leadId: lead || picked[0] } });
      setProjectName("");
      setPicked([]);
      setLead("");
      projects.reload();
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
      const defaults = (plugins.data?.plugins ?? []).filter((p) => p.forAll !== false).map((p) => p.name);
      setDraft((cur) => (cur && cur.id === "" && cur.name.trim() ? cur : { ...blankAgent(), plugins: defaults }));
      return;
    }
    const found = agents.data?.agents.find((a) => a.id === agentId);
    if (found) setDraft(found);
  }, [agentId, agents.data, plugins.data]);
  const patch = (part: Partial<AgentRecord>): void => setDraft(draft ? { ...draft, ...part } : draft);
  const defaults = rows.filter((p) => p.forAll !== false).map((p) => p.name);
  const chosen = draft?.plugins.length ? draft.plugins : defaults;
  const togglePlugin = (name: string): void => {
    if (!draft) return;
    const has = chosen.includes(name);
    patch({ plugins: has ? chosen.filter((n) => n !== name) : [...chosen, name] });
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

  return (
    <section class="page">
      <h2>Агенты</h2>
      <p class="muted small">Карточка — это запись агента. Своего чата у неё нет, пока агента не добавили в проект.</p>
      {error && <p class="error">{error}</p>}
      {!agentId && <p class="muted small">Выберите агента слева или создайте нового.</p>}
      {draft && (
        <div class="settings-sheet">
            <div class="tabs">
              {(["general", "plugins", "skills", "mcp"] as const).map((id) => (
                <button key={id} class={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                  {id === "general" ? "Общее" : id === "plugins" ? "Плагины" : id === "skills" ? "Навыки" : "MCP"}
                </button>
              ))}
            </div>
            {tab === "general" && (
              <div class="fields">
                <label>Аватар<input type="file" accept="image/*" onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) onAvatar(f); }} /></label>
                <label>Имя<input value={draft.name} onInput={(e) => patch({ name: e.currentTarget.value })} /></label>
                <label>Специализация<input value={draft.specialization} onInput={(e) => patch({ specialization: e.currentTarget.value })} /></label>
                <label>Краткое описание<textarea rows={2} value={draft.summary} onInput={(e) => patch({ summary: e.currentTarget.value })} /></label>
                <label>AGENTS.md<textarea rows={8} value={draft.persona} onInput={(e) => patch({ persona: e.currentTarget.value })} /></label>
                <ModelSelect label="Модель по умолчанию" value={draft.model} onChange={(model) => patch({ model, fallback: draft.fallback || model, serviceModel: draft.serviceModel || model })} allowEmpty />
                <FallbackPick value={draft.fallback || draft.model || installModel} onChange={(fallback) => patch({ fallback })} />
                <h3>Служебные вызовы</h3>
                <ModelSelect label="Модель служебных вызовов" value={draft.serviceModel || draft.model || installModel} onChange={(serviceModel) => patch({ serviceModel })} />
                <label>Сжатие переписки<textarea rows={4} value={draft.compress} onInput={(e) => patch({ compress: e.currentTarget.value })} /></label>
                <label>Факты<textarea rows={4} value={draft.facts} onInput={(e) => patch({ facts: e.currentTarget.value })} /></label>
                <h3>Зависший ход</h3>
                <label>Секунд тишины. Пусто — порог установки. 0 — не следить.<input value={draft.stallSeconds ?? ""} onInput={(e) => { const v = e.currentTarget.value.trim(); patch({ stallSeconds: v === "" ? null : Number(v) }); }} /></label>
              </div>
            )}
            {tab === "plugins" && <AgentPluginTiles rows={tools} chosen={chosen} onToggle={togglePlugin} />}
            {tab === "mcp" && <AgentPluginTiles rows={mcp} chosen={chosen} onToggle={togglePlugin} empty="Подключённых MCP нет." />}
            {tab === "skills" && (
              <div class="checks">
                {(skills.data?.skills ?? []).map((s) => (
                  <label key={s.name} class="check">
                    <input type="checkbox" checked={draft.skills.includes(s.name)} onChange={() => patch({ skills: draft.skills.includes(s.name) ? draft.skills.filter((n) => n !== s.name) : [...draft.skills, s.name] })} />
                    <span><b>{s.name}</b><div class="small muted">{s.description}</div></span>
                  </label>
                ))}
                {(skills.data?.skills.length ?? 0) === 0 && <p class="muted small">В папке skills пока нет навыков.</p>}
              </div>
            )}
            <div class="tool-actions">
              <button disabled={!draft.name.trim()} onClick={() => void saveAgentForm()}>Сохранить</button>
            </div>
        </div>
      )}
      <h2>Проекты</h2>
      <ul>
        {projects.data?.projects.map((p) => (
          <li key={p.id}>
            <b>{p.name}</b> <span class="muted small">агентов: {p.agentIds.length}</span>
            <button class="link small" onClick={() => void api(`/v1/roster/projects/${p.id}`, { method: "DELETE" }).then(() => projects.reload())}>удалить</button>
          </li>
        ))}
      </ul>
      <div class="fields">
        <label>Название<input value={projectName} onInput={(e) => setProjectName(e.currentTarget.value)} /></label>
        {(agents.data?.agents ?? []).map((a) => (
          <label key={a.id} class="check">
            <input type="checkbox" checked={picked.includes(a.id)} onChange={() => { const next = picked.includes(a.id) ? picked.filter((id) => id !== a.id) : [...picked, a.id]; setPicked(next); if (!next.includes(lead)) setLead(next[0] ?? ""); }} />
            {a.name}{" "}
            {picked.includes(a.id) && <button type="button" class="link small" onClick={() => setLead(a.id)}>{lead === a.id ? "ведущий" : "сделать ведущим"}</button>}
          </label>
        ))}
        <button disabled={!projectName.trim()} onClick={() => void saveProject()}>Создать проект</button>
        <p class="muted small">Папки: workspace/projects/имя/_inbox, _out, _work.</p>
      </div>
    </section>
  );
}

function AgentPluginTiles({ rows, chosen, onToggle, empty }: { rows: PluginRow[]; chosen: string[]; onToggle: (name: string) => void; empty?: string }) {
  if (!rows.length) return <p class="muted small">{empty || "Запущенных плагинов нет."}</p>;
  return (
    <div class="plugin-grid">
      {rows.map((p) => {
        const on = chosen.includes(p.name);
        return (
          <div key={p.name} class="plugin-tile">
            <div><b>{p.name}</b><div class="small muted">{p.description}</div></div>
            <button type="button" class={on ? "secondary sm" : "ghost sm"} onClick={() => onToggle(p.name)}>{on ? "включён" : "выключен"}</button>
          </div>
        );
      })}
    </div>
  );
}
