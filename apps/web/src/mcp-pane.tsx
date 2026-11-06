import { useEffect, useState } from "preact/hooks";
import { api } from "./api";
import { CURATED_MCP, type CuratedMcp } from "./mcp-curated";
import { CSelect, Tog } from "./cselect.js";

interface PluginRow {
  name: string;
  version: string;
  description: string;
  location: string;
  disabled: boolean;
  tools: string[];
  runtime?: string;
  forAll?: boolean;
  defaultOn?: boolean;
}

interface InstallResult {
  name: string;
  runtime: string;
  started: boolean;
  tools: string[];
  startError?: string;
  next?: string;
}

export interface AddDraft {
  name: string;
  description: string;
  runtime: "mcp-stdio" | "http";
  commandText: string;
  url: string;
  envText: string;
}

function isMcp(p: PluginRow): boolean {
  return p.runtime === "mcp-stdio" || p.runtime === "http";
}

function draftFromCurated(c: CuratedMcp): AddDraft {
  return {
    name: c.id,
    description: c.summary,
    runtime: c.runtime,
    commandText: c.command?.join(" ") ?? "",
    url: c.url ?? "",
    envText: c.envHints
      ? Object.entries(c.envHints)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      : "",
  };
}

/** Settings → MCP: installed MCP plugins, curated catalog, and a form to add one via POST /v1/plugins/mcp. */
export function McpPane() {
  const [tab, setTab] = useState<"list" | "catalog" | "add">("list");
  const [plugins, setPlugins] = useState<PluginRow[]>([]);
  const [enabled, setEnabled] = useState<string[]>([]);
  const [showDisabled, setShowDisabled] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<AddDraft | null>(null);

  const load = async (): Promise<void> => {
    const [plist, settings, sections] = await Promise.all([
      api<{ plugins: PluginRow[] }>("/v1/plugins"),
      api<{ plugins: { name: string; enabled: boolean }[] }>("/v1/settings"),
      api<{ sections: { id: string; values: Record<string, unknown> }[] }>("/v1/settings/sections"),
    ]);
    setPlugins(plist.plugins);
    setEnabled(settings.plugins.filter((p) => p.enabled).map((p) => p.name));
    const v = sections.sections.find((s) => s.id === "plugin.mcp-catalog")?.values.showDisabled;
    setShowDisabled(v !== false);
  };

  useEffect(() => {
    void load().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const rows = plugins.filter(isMcp).filter((p) => showDisabled || enabled.includes(p.name));
  const installed = new Set(plugins.filter(isMcp).map((p) => p.name));

  const setOn = async (name: string, on: boolean): Promise<void> => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const cur = await api<{ model: string; plugins: { name: string; enabled: boolean }[] }>("/v1/settings");
      const enabledNow = on
        ? [...new Set([...cur.plugins.filter((p) => p.enabled).map((p) => p.name), name])]
        : cur.plugins.filter((p) => p.enabled && p.name !== name).map((p) => p.name);
      await api("/v1/settings", { method: "PUT", body: { model: cur.model, fallback: [], enabled: enabledNow } });
      setNotice(
        on
          ? "Включён в config.yaml. Подхватится после перезапуска sinty web."
          : "Выключен в config.yaml. Действует после перезапуска sinty web.",
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const useCurated = (c: CuratedMcp): void => {
    setError("");
    setNotice(`Шаблон «${c.title}» подставлен в форму. Проверьте command/env и секреты, затем Установить.`);
    setDraft(draftFromCurated(c));
    setTab("add");
  };

  return (
    <div class="settings-sheet settings-ux">
      <div class="card">
      <div class="section-h"><h3>MCP</h3></div>
      <p class="note">
        Внешние MCP как плагины Sinty (mcp-stdio / http). Каталог — готовые карточки; «Добавить» — произвольный MCP.
        Установка через POST /v1/plugins/mcp (как mcp.install). Секреты только secret://…. Видимость у агента — вкладка MCP в карточке агента.
      </p>
      <div class="seg pills">
        <button type="button" class={tab === "list" ? "on" : ""} onClick={() => setTab("list")}>Установленные</button>
        <button type="button" class={tab === "catalog" ? "on" : ""} onClick={() => setTab("catalog")}>Каталог</button>
        <button type="button" class={tab === "add" ? "on" : ""} onClick={() => setTab("add")}>Добавить</button>
      </div>
      {error && <p class="error">{error}</p>}
      {notice && <p class="note">{notice}</p>}
      {tab === "list" ? (
        <>
          <label class="check" style={{ marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={showDisabled}
              disabled={busy}
              onChange={(e) => {
                const next = e.currentTarget.checked;
                setShowDisabled(next);
                void api("/v1/settings/sections/plugin.mcp-catalog", {
                  method: "PUT",
                  body: { values: { showDisabled: next } },
                }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
              }}
            />
            <span>Показывать выключенные</span>
          </label>
          <div class="plugin-grid">
            {rows.map((p) => {
              const on = enabled.includes(p.name);
              const status = !on
                ? "выключен"
                : p.tools.length > 0
                  ? `запущен · ${p.tools.length} тул.`
                  : "включён · нет тулов / ошибка старта";
              return (
                <div key={p.name} class={on ? "plugin-tile on" : "plugin-tile"}>
                  <div class="plugin-av">{p.name.slice(0, 1)}</div>
                  <div class="plugin-txt">
                    <b>{p.name}</b>
                    <span>{p.runtime} · {p.location} · {status}{p.description ? ` · ${p.description}` : ""}</span>
                  </div>
                  <Tog on={on} disabled={busy || p.defaultOn} onClick={() => void setOn(p.name, !on)} label={on ? "выключить" : "включить"} />
                </div>
              );
            })}
          </div>
          {rows.length === 0 && (
            <p class="muted">
              Нет MCP-плагинов. Откройте «Каталог» или «Добавить».
            </p>
          )}
        </>
      ) : tab === "catalog" ? (
        <CatalogTab installed={installed} busy={busy} onUse={useCurated} />
      ) : (
        <AddMcp
          busy={busy}
          setBusy={setBusy}
          draft={draft}
          onError={setError}
          onDone={(msg) => {
            setNotice(msg);
            setDraft(null);
            setTab("list");
            void load();
          }}
        />
      )}
      </div>
    </div>
  );
}

function CatalogTab({
  installed,
  busy,
  onUse,
}: {
  installed: Set<string>;
  busy: boolean;
  onUse: (c: CuratedMcp) => void;
}) {
  return (
    <section>
      <p class="small muted">
        Популярные MCP под стек Sinty. «Использовать» открывает форму «Добавить» с готовым command/url и secret:// env — секреты создайте заранее.
      </p>
      <div class="plugin-grid">
        {CURATED_MCP.map((c) => {
          const have = installed.has(c.id);
          return (
            <div key={c.id} class="plugin-tile">
              <div class="plugin-av">{c.title.slice(0, 1)}</div>
              <div class="plugin-txt">
                <b>{c.title}</b>
                <span>{c.summary}{have ? " · уже в списке" : ""}</span>
              </div>
              <button type="button" class="btn sm" disabled={busy} onClick={() => onUse(c)}>Использовать</button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AddMcp({
  busy,
  setBusy,
  draft,
  onError,
  onDone,
}: {
  busy: boolean;
  setBusy: (v: boolean) => void;
  draft: AddDraft | null;
  onError: (m: string) => void;
  onDone: (msg: string) => void;
}) {
  const [name, setName] = useState(draft?.name ?? "");
  const [description, setDescription] = useState(draft?.description ?? "");
  const [runtime, setRuntime] = useState<"mcp-stdio" | "http">(draft?.runtime ?? "mcp-stdio");
  const [commandText, setCommandText] = useState(draft?.commandText ?? "");
  const [url, setUrl] = useState(draft?.url ?? "");
  const [envText, setEnvText] = useState(draft?.envText ?? "");
  const [replace, setReplace] = useState(false);

  useEffect(() => {
    if (!draft) return;
    setName(draft.name);
    setDescription(draft.description);
    setRuntime(draft.runtime);
    setCommandText(draft.commandText);
    setUrl(draft.url);
    setEnvText(draft.envText);
  }, [draft]);

  const parseEnv = (): Record<string, string> | undefined => {
    const lines = envText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return undefined;
    const env: Record<string, string> = {};
    for (const line of lines) {
      const i = line.indexOf("=");
      if (i <= 0) throw new Error(`Строка env должна быть KEY=secret://name: ${line}`);
      const key = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      if (!/^secret:\/\/[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(value)) {
        throw new Error(`env.${key} должен быть secret://… (сырые секреты запрещены)`);
      }
      env[key] = value;
    }
    return env;
  };

  const submit = async (): Promise<void> => {
    onError("");
    const id = name.trim();
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) {
      onError("Имя: строчные латиница/цифры/дефис, например github или postgres-local.");
      return;
    }
    let body: Record<string, unknown> = {
      name: id,
      runtime,
      replace,
      ...(description.trim() ? { description: description.trim() } : {}),
    };
    try {
      const env = parseEnv();
      if (env) body = { ...body, env };
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (runtime === "mcp-stdio") {
      const command = commandText.trim().split(/\s+/).filter(Boolean);
      if (!command.length) {
        onError("Для mcp-stdio укажите command (через пробел), например: npx -y @modelcontextprotocol/server-github");
        return;
      }
      body = { ...body, command };
    } else {
      const u = url.trim();
      if (!u) {
        onError("Для http укажите URL.");
        return;
      }
      body = { ...body, url: u };
    }
    if (
      !confirm(
        `Установить MCP «${id}»? Это создаст плагин в $SINTY_HOME/plugins и включит его (как mcp.install).`,
      )
    )
      return;
    setBusy(true);
    try {
      const result = await api<InstallResult>("/v1/plugins/mcp", { body });
      const detail = result.started
        ? `Установлен ${result.name} (${result.runtime}), тулы: ${result.tools.join(", ") || "—"}.`
        : `Папка ${result.name} записана, но старт не удался: ${result.startError ?? "unknown"}.`;
      onDone(detail + (result.next ? ` ${result.next}` : ""));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div class="grid-2">
      <label class="field">
        Имя
        <input value={name} placeholder="github" disabled={busy} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label class="field">
        Описание
        <input
          value={description}
          placeholder="опционально"
          disabled={busy}
          onInput={(e) => setDescription(e.currentTarget.value)}
        />
      </label>
      <label class="field">
        Runtime
        <CSelect
          value={runtime}
          disabled={busy}
          onChange={(v) => setRuntime(v === "http" ? "http" : "mcp-stdio")}
          options={[
            { value: "mcp-stdio", label: "mcp-stdio", sub: "локальная команда" },
            { value: "http", label: "http", sub: "удалённый MCP" },
          ]}
        />
      </label>
      {runtime === "mcp-stdio" ? (
        <label class="field">
          Command (слова через пробел)
          <input
            value={commandText}
            placeholder="npx -y @modelcontextprotocol/server-github"
            disabled={busy}
            onInput={(e) => setCommandText(e.currentTarget.value)}
          />
        </label>
      ) : (
        <label class="field">
          URL
          <input value={url} placeholder="https://…" disabled={busy} onInput={(e) => setUrl(e.currentTarget.value)} />
        </label>
      )}
      <label class="field">
        Env (по строке KEY=secret://name)
        <textarea
          rows={3}
          value={envText}
          placeholder={"GITHUB_PERSONAL_ACCESS_TOKEN=secret://github.token"}
          disabled={busy}
          onInput={(e) => setEnvText(e.currentTarget.value)}
        />
      </label>
      </div>
      <label class="check">
        <input type="checkbox" checked={replace} disabled={busy} onChange={(e) => setReplace(e.currentTarget.checked)} />
        <span>Заменить, если папка уже есть (replace)</span>
      </label>
      <div class="actions" style={{ marginTop: 12 }}>
        <button type="button" class="btn primary" disabled={busy || !name.trim()} onClick={() => void submit()}>Установить</button>
      </div>
    </section>
  );
}
