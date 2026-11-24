import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { CSelect, Tog } from '../../../apps/web/src/cselect';
import '../../../apps/web/src/style.css';
import './style.css';
type Settings = {
    enabled: boolean;
    retention: 'chat' | 'request';
    pinned: string[];
};
type Tool = {
    name: string;
    description: string;
    plugin: string;
};
type Metric = {
    baseline: number;
    pinned: number;
    activated: number;
    sent: number;
    baselineBytes: number;
    sentBytes: number;
    mode: string;
    reason: string;
};
let nonce = '', seq = 0;
const waiters = new Map<number, {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}>();
function rpc(op: string, path?: string, body?: unknown): Promise<any> { const id = ++seq; return new Promise((resolve, reject) => { const timer = setTimeout(() => { waiters.delete(id); reject(Error('Нет ответа интерфейса')); }, 15000); waiters.set(id, { resolve, reject, timer }); parent.postMessage({ sinty: 'tab/1', id, op, ...(path ? { path } : {}), ...(body ? { body } : {}), ...(op === 'dynamic-tools.catalog' ? { nonce } : {}) }, '*'); }); }
function App() {
    const [settings, set] = useState<Settings>({ enabled: false, retention: 'chat', pinned: [] }), [tools, catalog] = useState<Tool[]>([]), [metrics, measure] = useState<Metric[]>([]), [observed, observe] = useState(false), [query, search] = useState(''), [error, fail] = useState(''), [busy, working] = useState(false), [loaded, load] = useState(false);
    const refresh = async () => { try {
        const status = await rpc('get', '/status');
        set(status.settings);
        measure(status.metrics);
        observe(status.observed);
        const registry = await rpc('dynamic-tools.catalog');
        catalog(registry.tools);
        load(true);
        fail('');
    }
    catch (e) {
        fail((e as Error).message);
    } };
    useEffect(() => { const receive = (event: MessageEvent) => { if (event.source !== parent || event.origin !== location.origin && event.origin !== new URL(document.referrer || location.href).origin)
        return; const m = event.data; if (!m || m.sinty !== 'tab/1')
        return; if (m.op === 'init') {
        nonce = m.catalogNonce ?? '';
        document.documentElement.dataset.theme = m.theme;
        void refresh();
    } if (m.op === 'theme')
        document.documentElement.dataset.theme = m.theme; const pending = waiters.get(m.id); if (pending) {
        waiters.delete(m.id);
        clearTimeout(pending.timer);
        m.ok ? pending.resolve(m.data) : pending.reject(Error(m.error?.message ?? 'Ошибка'));
    } }; addEventListener('message', receive); parent.postMessage({ sinty: 'tab/1', op: 'ready' }, '*'); return () => removeEventListener('message', receive); }, []);
    const save = async (next: Settings) => { const previous = settings; set(next); working(true); try {
        const out = await rpc('post', '/settings', next);
        set(out.settings);
        fail('');
    }
    catch (e) {
        set(previous);
        fail((e as Error).message);
    }
    finally {
        working(false);
    } };
    const filtered = tools.filter(t => (t.name + ' ' + t.description + ' ' + t.plugin).toLocaleLowerCase().includes(query.toLocaleLowerCase())), groups = [...new Set(filtered.map(t => t.plugin))];
    const last = metrics.at(-1);
    return <main class="dt-page"><header class="dt-heading"><div><h2>Динамичные инструменты</h2><p class="muted">Схемы по запросу. Реестр интерфейса — не разрешение на выполнение.</p></div><Tog on={settings.enabled} disabled={busy || !loaded} label="Использовать динамический каталог" onClick={() => void save({ ...settings, enabled: !settings.enabled })}/></header>
 <section class="dt-card"><div class="dt-row"><div><strong>Сохранять выбранные схемы</strong><p class="muted">На чат — до сброса. На запрос — только ближайший логический запрос, включая его fallback.</p></div><div class="dt-select"><CSelect label="Срок активации" disabled={busy || !loaded} value={settings.retention} onChange={v => void save({ ...settings, retention: v as Settings['retention'] })} options={[{ value: 'chat', label: 'На чат' }, { value: 'request', label: 'На ближайший запрос' }]}/></div></div>
 <p class="dt-note">Это собственный переключатель режима. OFF передаёт полный исходный каталог со следующего запроса и не останавливает текущий ответ. Общая кнопка выключения плагина останавливает его процесс; повторное включение перемещает его после провайдеров. Для обёртки нужен первый приоритет.</p>
 {!observed && <p role="status" class="dt-warning">Приоритет пока не подтверждён: обёртка ещё не наблюдала запросов. Если после реальной работы счётчики не появляются, проверьте порядок плагинов.</p>}
 <div class="dt-actions"><button class="btn" disabled={busy} onClick={() => void refresh()}>Обновить список и измерения</button><button class="btn" disabled={busy} onClick={() => { if (confirm('Сбросить активацию для будущих запросов? Текущие вызовы не отменяются.'))
        void rpc('post', '/reset', {}).then(refresh).catch(e => fail(e.message)); }}>Сбросить активацию</button></div></section>
 <section class="dt-card"><h3>Размер отправляемых схем</h3>{last ? <><div class="dt-stats">{[['Полный каталог', last.baseline], ['Закреплено', last.pinned], ['Активировано', last.activated], ['Отправлено', last.sent]].map(([label, value]) => <div><span>{label}</span><b>{value}</b></div>)}</div><p>{last.baselineBytes.toLocaleString()} → {last.sentBytes.toLocaleString()} байт JSON UTF-8 · режим {last.mode}</p></> : <p class="muted">Измерений ещё нет. Платный запрос для проверки автоматически не выполняется.</p>}<p class="muted">Это байты массива tools, включая поиск. Не токены, не доллары и не размер всей истории. Context Inspector в ядре видит полный каталог до обёртки; изменение схем может ухудшить cache hits.</p></section>
 <section class="dt-card"><h3>Всегда в контексте</h3><p class="muted">Закреплённые инструменты исключены из пула поиска. Поиск доступен всегда, если разрешён этому агенту. Права, включённость плагинов и дочерний allowlist проверяются независимо.</p><input class="dt-search" aria-label="Поиск инструментов" placeholder="Название, описание или плагин" value={query} onInput={e => search(e.currentTarget.value)}/><p class="muted">Реестр: {tools.length} · найдено: {filtered.length} · выбрано: {settings.pinned.length}</p>{groups.map(group => <section class="dt-group"><h4>{group}</h4>{filtered.filter(t => t.plugin === group).map(tool => <label class="dt-tool"><input type="checkbox" disabled={busy || tool.name === 'dynamic-tools.search'} checked={tool.name === 'dynamic-tools.search' || settings.pinned.includes(tool.name)} onChange={e => void save({ ...settings, pinned: e.currentTarget.checked ? [...settings.pinned, tool.name] : settings.pinned.filter(n => n !== tool.name) })}/><span><strong>{tool.name}</strong><small>{tool.description}</small></span><span class="dt-pin">Всегда в контексте</span></label>)}</section>)}</section>{error && <p role="alert" class="error">{error}</p>}</main>;
}
render(<App />, document.body);
