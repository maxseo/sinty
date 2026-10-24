import { useEffect, useState } from "preact/hooks";
import { SkillsPane } from "./skills-pane";
import { McpPane } from "./mcp-pane";
import { api, shortTime, type SintyEvent } from "./api.js";
import { href } from "./route.js";

// ---- the «Супервизор» chat-header tab ----

interface SupervisorData {
  enabled: boolean;
  events: SintyEvent[];
  incidents: { id: string; tool: string; code: string; message: string; fixSummary: string; createdAt: string }[];
  patches: { id: string; plugin: string; sessionId: string; status: string; reason: string; files: string[]; permissionsChanged: boolean; commit: string | null; createdAt: string }[];
}

const KIND: Record<string, string> = { notice: "замечание", escalated: "остановка", incident_resolved: "решено" };

/** Long remarks fold to two lines; a click shows the rest. Texts arrive masked from /v1/supervisor. */
function Long({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= 220) return <span class="sup-text">{text}</span>;
  return (
    <span class={`sup-text ${open ? "" : "folded"}`} title={open ? "" : "Показать полностью"} onClick={() => setOpen(!open)}>
      {open ? text : `${text.slice(0, 220)}…`}
    </span>
  );
}

/** Remarks, stops, incidents and patches of this chat; «Все чаты» widens it to the whole install. */
export function SupervisorView({ sessionId, tick }: { sessionId: string; tick: number }) {
  const [all, setAll] = useState(false);
  const [data, setData] = useState<SupervisorData>();
  const [error, setError] = useState("");
  useEffect(() => {
    api<SupervisorData>(all ? "/v1/supervisor?limit=200" : `/v1/supervisor?limit=200&sessionId=${encodeURIComponent(sessionId)}`)
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [sessionId, all, tick]);
  return (
    <div class="sup-view">
      <div class="sup-tools">
        <span class={`status ${data?.enabled ? "running" : "idle"}`}>{data?.enabled ? "супервизор включён" : "супервизор выключен"}</span>
        <div class="tabs">
          <button class={all ? "" : "on"} onClick={() => setAll(false)}>Этот чат</button>
          <button class={all ? "on" : ""} onClick={() => setAll(true)}>Все чаты</button>
        </div>
        <a class="small" href={href({ page: "settings", section: "supervisor" })}>Настройки супервизора</a>
      </div>
      {error && <p class="error">{error}</p>}
      <h3>Замечания</h3>
      {data && !data.events.length && <p class="muted">{all ? "Замечаний пока нет." : "В этом чате супервизор ничего не заметил."}</p>}
      <table class="sup-table">
        <tbody>
          {data?.events.map((e) => {
            const d = e.data as Record<string, unknown>;
            const kind = e.type.replace("supervisor.", "");
            const text = String(d.text ?? d.reason ?? d.fixSummary ?? "");
            return (
              <tr key={e.id}>
                <td class="small nowrap">{shortTime(e.ts)}</td>
                <td>
                  <span class={`sup-kind ${kind}`}>{KIND[kind] ?? kind}</span>
                </td>
                <td class="small nowrap">{String(d.detector ?? d.tool ?? "")}{typeof d.level === "number" ? ` · ${d.level}` : ""}</td>
                <td><Long text={text} /></td>
                {all && <td class="nowrap">{e.sessionId === sessionId ? <span class="small muted">этот чат</span> : <a class="small" href={href({ page: "chat", sessionId: e.sessionId })}>чат</a>}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      <h3>Инциденты</h3>
      <p class="small muted">Ошибки, которые агент потом исправил. Супервизор подсказывает эти решения при похожих ошибках. Введённый текст, пароли и токены скрыты, длинные значения обрезаны.</p>
      {data && !data.incidents.length && <p class="muted">Инцидентов нет.</p>}
      <table class="sup-table">
        <tbody>
          {data?.incidents.map((i) => (
            <tr key={i.id}>
              <td class="small nowrap">{shortTime(i.createdAt)}</td>
              <td class="nowrap">
                <code>{i.tool}</code> <span class="small muted">{i.code}</span>
              </td>
              <td class="small"><Long text={i.message} /></td>
              <td><Long text={i.fixSummary} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {(data?.patches.length ?? 0) > 0 && (
        <>
          <h3>Патчи плагинов</h3>
          <table class="sup-table">
            <tbody>
              {data?.patches.map((p) => (
                <tr key={p.id}>
                  <td class="small nowrap">{shortTime(p.createdAt)}</td>
                  <td><code>{p.plugin}</code></td>
                  <td class="nowrap">
                    <span class={`status ${p.status}`}>{p.status}</span>
                    {p.permissionsChanged && <span class="status blocked">права</span>}
                  </td>
                  <td><Long text={p.reason} /></td>
                  <td class="small muted">{p.files.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ---- generic settings sections (core supervisor + plugin manifest `settings`) ----

export interface SettingsField {
  key: string;
  label: string;
  type: "number" | "boolean" | "select" | "text";
  help?: string;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  optional?: boolean;
  options?: { value: string; label: string }[];
  unit?: string;
}

export interface SectionInfo {
  id: string;
  title: string;
  description?: string;
  owner: "core" | "plugin";
  plugin?: string;
  fields: SettingsField[];
  values: Record<string, unknown>;
  defaults: Record<string, unknown>;
  restart: boolean;
  store?: "config.yaml" | "policy.yaml";
}

export function useSections(deps: unknown[]): SectionInfo[] {
  const [sections, setSections] = useState<SectionInfo[]>([]);
  useEffect(() => {
    api<{ sections: SectionInfo[] }>("/v1/settings/sections")
      .then((r) => setSections(r.sections))
      .catch(() => setSections([]));
  }, deps);
  return sections;
}

type Draft = Record<string, string | boolean>;

function toDraft(s: SectionInfo): Draft {
  const d: Draft = {};
  for (const f of s.fields) {
    const v = s.values[f.key];
    d[f.key] = f.type === "boolean" ? v === true : v === undefined || v === null ? "" : String(v);
  }
  return d;
}

/** One section as a form; only changed fields are sent. */
export function SectionPane({ id }: { id: string }) {
  if (id === "plugin.mcp-catalog") return <McpPane />;
  if (id === "plugin.skills") return <SkillsPane />;
  const [section, setSection] = useState<SectionInfo>();
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    setNotice("");
    api<{ sections: SectionInfo[] }>("/v1/settings/sections")
      .then((r) => {
        const s = r.sections.find((x) => x.id === id);
        setSection(s);
        if (s) setDraft(toDraft(s));
        setError(s ? "" : "Раздел не найден: плагин выключен или не запущен.");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);
  if (!section) return error ? <p class="error">{error}</p> : null;
  const base = toDraft(section);
  const changed = section.fields.filter((f) => draft[f.key] !== base[f.key]);
  const save = async (): Promise<void> => {
    setError("");
    setNotice("");
    const values: Record<string, unknown> = {};
    for (const f of changed) {
      const v = draft[f.key];
      values[f.key] = f.type === "boolean" ? v : f.type === "number" ? (v === "" ? null : Number(v)) : v === "" && f.optional ? null : v;
    }
    try {
      const r = await api<{ restart: boolean; section: SectionInfo }>(`/v1/settings/sections/${encodeURIComponent(id)}`, { method: "PUT", body: { values } });
      setSection(r.section);
      setDraft(toDraft(r.section));
      const file = r.section.store ?? (id === "policy" ? "policy.yaml" : "config.yaml");
      setNotice(r.restart ? `Сохранено в ${file}. Действует после перезапуска sinty web.` : `Сохранено в ${file} и уже действует.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const groups: { name: string; fields: SettingsField[] }[] = [];
  for (const f of section.fields) {
    const name = f.group ?? "";
    const g = groups.find((x) => x.name === name);
    if (g) g.fields.push(f);
    else groups.push({ name, fields: [f] });
  }
  return (
    <div class="settings-sheet section-pane">
      <h3>{section.title}</h3>
      {section.description && <p class="small muted">{section.description}</p>}
      {section.owner === "plugin" && <p class="small muted">Плагин <code>{section.plugin}</code>. Значения в config.yaml: plugins.config.{section.plugin}.</p>}
      {section.id === "policy" && <p class="small muted">Файл <code>policy.yaml</code>. Инструменты его писать не могут — только этот экран (и ручное редактирование).</p>}
      {groups.map((g) => (
        <fieldset key={g.name} class="set-group">
          {g.name && <legend>{g.name}</legend>}
          {g.fields.map((f) => {
            const v = draft[f.key];
            const set = (x: string | boolean): void => setDraft({ ...draft, [f.key]: x });
            const fallback = section.defaults[f.key];
            const help = f.help ? <span class="small muted">{f.help}</span> : null;
            if (f.type === "boolean") {
              return (
                <label key={f.key} class="check">
                  <input type="checkbox" checked={v === true} onChange={(e) => set(e.currentTarget.checked)} />
                  <span>
                    {f.label}
                    {help && <br />}
                    {help}
                  </span>
                </label>
              );
            }
            return (
              <label key={f.key} class="field set-field">
                <span>
                  {f.label}
                  {f.unit ? `, ${f.unit}` : ""}
                </span>
                {f.type === "select" ? (
                  <select value={String(v)} onChange={(e) => set(e.currentTarget.value)}>
                    {(f.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={f.type === "number" ? "number" : "text"}
                    value={String(v)}
                    {...(f.min !== undefined ? { min: f.min } : {})}
                    {...(f.max !== undefined ? { max: f.max } : {})}
                    step={f.step ?? (f.integer ? 1 : "any")}
                    placeholder={f.optional && fallback !== undefined ? `пусто: ${String(fallback)}` : ""}
                    onInput={(e) => set(e.currentTarget.value)}
                  />
                )}
                {help}
              </label>
            );
          })}
        </fieldset>
      ))}
      <div class="row">
        <button disabled={!changed.length} onClick={() => void save()}>Сохранить</button>
        {changed.length > 0 && <button class="secondary" onClick={() => setDraft(base)}>Отменить</button>}
      </div>
      {notice && <p class="small">{notice}</p>}
      {error && <p class="error">{error}</p>}
    </div>
  );
}
