import { pilotAgentChoices, pilotAgentMessage, type PilotChoices } from "./browser-pilot-state.js";
﻿import { useEffect, useState } from "preact/hooks";
import { api } from "./api.js";
import { href } from "./route.js";
interface Lease { sessionId: string; agentId: string; mode: string; pending: boolean; expires: number; fixture: string; ready: boolean; scope?: "public" | "fixture"; url?: string | null }
interface Pilot extends PilotChoices { ready: boolean; reason: string | null; leases: Lease[] }
export function BrowserPilotPanel() {
  const [pilot, setPilot] = useState<Pilot>(); const [project, setProject] = useState(""); const [agent, setAgent] = useState(""); const [upload, setUpload] = useState(""); const [text, setText] = useState("Вызови prepare, затем goto. Заполни локальную форму тестовыми данными, приложи выбранный файл проекта, если он разрешён. Получи state со снимком. Ничего не отправляй."); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const refresh = async (signal?: AbortSignal) => { try { setPilot(await api<Pilot>("/v1/browser-pilot", { signal })); } catch (e) { if (!signal?.aborted) setError(String(e)); } };
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); const id = setInterval(() => void refresh(controller.signal), 2000); return () => { clearInterval(id); controller.abort(); }; }, []);
  const run = async (path: string, body: unknown) => { setBusy(true); setError(""); try { await api(path, { body }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const choices = pilotAgentChoices(pilot, project);
  const agentMessage = pilotAgentMessage(pilot, project);
  return <section style="padding:24px;max-width:850px"><h1>Браузер</h1>
    <p>Попросите выбранного агента в обычном чате открыть сайт. Откроется отдельный Chromium с сохраняемым профилем. Здесь — пауза, ручной вход, возврат агенту и закрытие. Сессия — до 20 минут.</p>
    {!pilot?.ready && <p role="status">Плагин Browser недоступен. Проверьте его статус в плагинах; браузер автоматически не запускается.</p>}
    <details><summary>Необязательно: локальная тестовая форма</summary>
    <label>Проект <select value={project} onChange={(e) => { setProject(e.currentTarget.value); setAgent(""); }}><option value="">Выберите</option>{pilot?.projects.map((p) => <option value={p.id}>{p.name}</option>)}</select></label>
    <label>Агент <select disabled={!project || choices.length === 0 || busy} value={agent} onChange={(e) => setAgent(e.currentTarget.value)}><option value="">Выберите</option>{choices.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
    {agentMessage && <p role="status">{agentMessage}</p>}
    <label>Разрешённый файл проекта (относительный путь, через /) <input value={upload} onInput={(e) => setUpload(e.currentTarget.value)} /></label>
    <button disabled={!pilot?.ready || !project || !choices.some(a => a.id === agent) || busy} onClick={() => void run("/v1/browser-pilot", { projectId: project, agentId: agent, uploads: upload.trim() ? [upload.trim()] : [] })}>Создать пилотную сессию</button>
    </details>
    <p>Публичные HTTP(S)-сайты доступны; приватные адреса, WebSocket и всплывающие окна заблокированы. Клики, ввод и файлы требуют подтверждения: кнопка может отправить данные независимо от подписи.</p>
    <p>Взять управление можно только после завершения текущей операции. «Остановка ожидается» — не подтверждение остановки. Неизвестный исход блокирует дальнейшие действия до проверенного закрытия.</p>
    {pilot?.leases.map((l) => <article style="border:1px solid;padding:12px;margin:12px 0"><strong>{({ inactive: "Неактивен", agent: "Управляет агент", manual: "Ручное управление", pausing: "Остановка ожидается", closing: "Закрывается", quarantined: "Исход неизвестен — заблокирован" } as Record<string,string>)[l.mode] ?? l.mode}</strong>
      {l.mode === "quarantined" && <p role="status">Исход последней операции неизвестен. Закройте эту сессию кнопкой ниже, затем попросите агента открыть сайт заново. «Вернуть агенту» здесь не поможет.</p>}
      <p>{l.scope === "public" ? l.url || "Публичные сайты · страница ещё не проверена" : l.fixture} · {l.pending ? "операция ещё выполняется" : "операций нет"}</p>
      <a href={href({ page: "chat", sessionId: l.sessionId })}>Журнал сессии</a>
      <button disabled={busy || ["manual", "quarantined", "closing"].includes(l.mode)} onClick={() => void run(`/v1/browser-pilot/${l.sessionId}/control`, { action: "pause" })}>Пауза / взять управление</button>
      <button disabled={busy || l.mode !== "manual" || l.pending} onClick={() => void run(`/v1/browser-pilot/${l.sessionId}/control`, { action: "resume" })}>Вернуть агенту</button>
      <button disabled={busy} onClick={() => void run(`/v1/browser-pilot/${l.sessionId}/control`, { action: "release" })}>Закрыть сессию</button>
      {l.scope !== "public" && <><textarea aria-label="Тестовая задача" value={text} onInput={(e) => setText(e.currentTarget.value)} />
      <button disabled={busy || !l.ready || !["inactive", "agent"].includes(l.mode)} onClick={() => void run(`/v1/browser-pilot/${l.sessionId}/send`, { text })}>Передать тестовую задачу</button></>}
      <p>Окно открывается по prepare из чата. Для ручного входа дождитесь статуса «Ручное управление», затем верните управление агенту. Пароли вводите только сами в этом окне.</p>
    </article>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
