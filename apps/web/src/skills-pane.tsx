import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api";

interface SkillRow {
  name: string;
  description: string;
}

interface SkillItem extends SkillRow {
  text: string;
  truncated: boolean;
  files: string[];
}

/** Settings → Навыки: installed skills, a viewer, and ways to add one. */
export function SkillsPane() {
  const [tab, setTab] = useState<"list" | "add">("list");
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState("60");
  const [savedLimit, setSavedLimit] = useState("60");

  const load = async (): Promise<void> => {
    const list = await api<{ skills: SkillRow[]; disabled?: boolean }>("/v1/roster/skills");
    setSkills(list.skills);
    setDisabled(Boolean(list.disabled));
  };

  useEffect(() => {
    void load().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    void api<{ sections: { id: string; values: Record<string, unknown> }[] }>("/v1/settings/sections")
      .then((r) => {
        const n = r.sections.find((s) => s.id === "plugin.skills")?.values.catalogLimit;
        const text = n === undefined || n === null ? "60" : String(n);
        setLimit(text);
        setSavedLimit(text);
      })
      .catch(() => undefined);
  }, []);

  const saveLimit = async (): Promise<void> => {
    setError("");
    setNotice("");
    try {
      await api("/v1/settings/sections/plugin.skills", { method: "PUT", body: { values: { catalogLimit: Number(limit) } } });
      setSavedLimit(limit);
      setNotice("Лимит каталога сохранён. Он попадёт в промпт после перезапуска sinty web.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div class="settings-sheet">
      <h3>Навыки</h3>
      <div class="tabs">
        <button type="button" class={tab === "list" ? "on" : ""} onClick={() => setTab("list")}>Доступные навыки</button>
        <button type="button" class={tab === "add" ? "on" : ""} onClick={() => setTab("add")}>Добавить навык</button>
      </div>
      {error && <p class="error">{error}</p>}
      {notice && <p class="small">{notice}</p>}
      {disabled && <p class="muted">Плагин skills выключен. Включите его в разделе «Плагины» и перезапустите sinty web.</p>}
      {tab === "list" ? (
        <>
          <label class="field">Навыков в каталоге<span class="small muted">Сколько навыков перечислять в промпте. Остальные открываются по имени.</span>
            <input type="number" min={1} max={500} value={limit} onInput={(e) => setLimit(e.currentTarget.value)} />
          </label>
          <button type="button" class="secondary" disabled={limit === savedLimit} onClick={() => void saveLimit()}>Сохранить лимит</button>
          <div class="plugin-grid">
            {skills.map((s) => (
              <button type="button" key={s.name} class="skill-card" onClick={() => setOpen(s.name)}>
                <b>{s.name}</b>
                <span class="small muted">{s.description || "без описания"}</span>
              </button>
            ))}
          </div>
          {skills.length === 0 && !disabled && <p class="muted">В папке skills пока нет навыков.</p>}
        </>
      ) : (
        <AddSkill disabled={disabled} onDone={() => { setTab("list"); setNotice("Навык записан. Каталог в промпте обновится после перезапуска sinty web."); void load(); }} onError={setError} />
      )}
      {open && <SkillView name={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function AddSkill({ disabled, onDone, onError }: { disabled: boolean; onDone: () => void; onError: (m: string) => void }) {
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const zipRef = useRef<HTMLInputElement>(null);

  const run = async (body: Record<string, unknown>): Promise<void> => {
    onError("");
    setBusy(true);
    try {
      const result = await api<{ code?: number; output?: string; name?: string }>("/v1/skills/install", { body });
      if (typeof result.code === "number" && result.code !== 0) {
        onError(result.output || `команда завершилась с кодом ${result.code}`);
        return;
      }
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sendFolder = async (): Promise<void> => {
    const pick = (window as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    if (!pick) {
      onError("Этот браузер не умеет выбирать папку. Откройте страницу в Chrome или Edge.");
      return;
    }
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await pick();
    } catch {
      return;
    }
    const files: { path: string; dataBase64: string }[] = [];
    const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const [name, entry] of handle.entries()) {
        if (name.startsWith(".") || name === "node_modules") continue;
        if (entry.kind === "file") {
          const file = await entry.getFile();
          if (file.size > 2_000_000 || files.length >= 200) continue;
          files.push({ path: `${prefix}/${name}`, dataBase64: await toBase64(file) });
        } else {
          await walk(entry, `${prefix}/${name}`);
        }
      }
    };
    await walk(dir, dir.name);
    await run({ files });
  };

  const sendZip = async (file: File | null): Promise<void> => {
    if (!file) return;
    await run({ zipBase64: await toBase64(file) });
  };

  return (
    <section class="panel">
      <div class="cmd-line">
        <input value={command} placeholder="npx skills add владелец/репозиторий" disabled={disabled || busy} onInput={(e) => setCommand(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") void run({ command }); }} />
        <button type="button" class="icon" title="Запустить" disabled={disabled || busy || !command.trim()} onClick={() => void run({ command })}>→</button>
      </div>
      <div class="row">
        <button type="button" class="secondary" disabled={disabled || busy} onClick={() => void sendFolder()}>Загрузить из папки</button>
        <button type="button" class="secondary" disabled={disabled || busy} onClick={() => zipRef.current?.click()}>Загрузить из zip</button>
        <button type="button" class="secondary" disabled={disabled || busy} onClick={() => setManual(true)}>Добавить скилл</button>
      </div>
      <input ref={zipRef} class="file-hidden" type="file" accept=".zip,application/zip" onChange={(e) => { void sendZip(e.currentTarget.files?.[0] ?? null); e.currentTarget.value = ""; }} />
      {manual && <ManualSkill disabled={disabled} onClose={() => setManual(false)} onDone={onDone} onError={onError} />}
    </section>
  );
}

function ManualSkill({ disabled, onClose, onDone, onError }: { disabled: boolean; onClose: () => void; onDone: () => void; onError: (m: string) => void }) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [when, setWhen] = useState("");
  const [body, setBody] = useState("");
  const [mdName, setMdName] = useState("");
  const save = async (): Promise<void> => {
    const folder = (slug.trim() || name.trim()).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const text = `---\nname: ${folder}\ndescription: ${desc.trim()}\n---\n\n# ${name.trim() || folder}\n\n## Когда использовать\n\n${when.trim()}\n\n${body.trim()}\n`;
    onError("");
    try {
      await api("/p/skills/import", { body: { name: folder, text } });
      onClose();
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  const pickMd = async (file: File | null): Promise<void> => {
    if (!file) return;
    setMdName(file.name);
    const text = await file.text();
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n*/.exec(text);
    const field = (key: string): string => fm?.[1]?.split(/\r?\n/).find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") ?? "";
    if (!slug && field("name")) setSlug(field("name"));
    if (!desc && field("description")) setDesc(field("description"));
    setBody(text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim());
  };
  return (
    <div class="overlay" onClick={onClose}>
      <form class="dialog skill-form" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <header class="dialog-head"><h3>Новый скилл</h3><button type="button" class="icon" onClick={onClose}>×</button></header>
        <label class="field">Slug (опционально)<input value={slug} placeholder="brand-voice" onInput={(e) => setSlug(e.currentTarget.value)} /></label>
        <label class="field">Название<input value={name} required onInput={(e) => setName(e.currentTarget.value)} /></label>
        <label class="field">Краткое описание<textarea rows={2} required value={desc} onInput={(e) => setDesc(e.currentTarget.value)} /></label>
        <label class="field">Когда использовать<textarea rows={3} required value={when} onInput={(e) => setWhen(e.currentTarget.value)} /></label>
        <label class="field">SKILL.md файл
          <input class="file-hidden" type="file" accept=".md,text/markdown" onChange={(e) => void pickMd(e.currentTarget.files?.[0] ?? null)} />
          <span class="small muted">{mdName || "Выбрать .md"}</span>
        </label>
        <label class="field">Инструкции (SKILL.md body)<textarea rows={10} required value={body} onInput={(e) => setBody(e.currentTarget.value)} /></label>
        <footer class="dialog-actions">
          <button type="button" class="secondary" onClick={onClose}>Отмена</button>
          <button type="submit" disabled={disabled || !name.trim() || !desc.trim() || !when.trim() || !body.trim()}>Сохранить</button>
        </footer>
      </form>
    </div>
  );
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function SkillView({ name, onClose }: { name: string; onClose: () => void }) {
  const [item, setItem] = useState<SkillItem | null>(null);
  const [path, setPath] = useState("SKILL.md");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void api<SkillItem>(`/p/skills/item?name=${encodeURIComponent(name)}`)
      .then((s) => {
        setItem(s);
        setText(bodyOf(s.text));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [name]);
  const show = async (next: string): Promise<void> => {
    setPath(next);
    if (next === "SKILL.md" && item) {
      setText(bodyOf(item.text));
      return;
    }
    const file = await api<{ text: string }>(`/p/skills/file?name=${encodeURIComponent(name)}&path=${encodeURIComponent(next)}`);
    setText(file.text);
  };
  return (
    <div class="overlay" onClick={onClose}>
      <div class="dialog skill-view" onClick={(e) => e.stopPropagation()}>
        <header class="dialog-head">
          <h3>{name}</h3>
          <button type="button" class="icon" onClick={onClose}>×</button>
        </header>
        {item?.description && <p class="muted">{item.description}</p>}
        {error && <p class="error">{error}</p>}
        <div class="skill-split">
          <pre>{text}</pre>
          <div class="skill-files">
            {(item?.files ?? ["SKILL.md"]).map((file) => (
              <button type="button" key={file} class={path === file ? "secondary on" : "secondary"} onClick={() => void show(file)}>{file === "SKILL.md" ? "Инструкция" : file}</button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function bodyOf(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "");
}
