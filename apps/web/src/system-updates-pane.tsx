import { useEffect, useState } from 'preact/hooks';
import { api } from './api.js';
interface Status {
    configured: boolean;
    checking: boolean;
    lastChecked: string | null;
    lastSuccess: string | null;
    error: string | null;
    harness: {
        version: string;
        changelog: string;
        applySupported: boolean;
        supportReason: string;
    }[];
    nextCheck: string | null;
}
export function SystemUpdatesPane() { const [state, setState] = useState<Status>(), [error, setError] = useState(''), [busy, setBusy] = useState(false); useEffect(() => { void api<Status>('/v1/updates').then(setState).catch(() => setError('Системная проверка обновлений доступна владельцу.')); }, []); async function check() { setBusy(true); setError(''); try {
    setState(await api<Status>('/v1/updates/check', { method: 'POST', body: {} }));
}
catch {
    setError('Проверка недоступна; текущая установка продолжает работать.');
}
finally {
    setBusy(false);
} } return <article class="card"><h3>Обновления Sinty</h3><p>Проверка версий выполняется в ядре примерно каждые 6 часов. Установка никогда не запускается автоматически.</p><button type="button" disabled={busy} onClick={() => void check()}>{busy ? 'Проверка…' : 'Проверить сейчас'}</button>{error && <p class="error">{error}</p>}{state && !state.configured && !state.error && <p class="note">Источник и доверенный ключ обновлений не настроены. Ключ не принимается автоматически из каталога.</p>}{state?.error && <p class="error">Не удалось проверить подпись или соединиться с центром. Последние успешные результаты сохранены; работа не остановлена.</p>}{state?.lastChecked && <p class="note">Последняя попытка: {new Date(state.lastChecked).toLocaleString()} · успешно: {state.lastSuccess ? new Date(state.lastSuccess).toLocaleString() : 'ещё нет'}</p>}{state?.harness.map(r => <section key={r.version}><b>Версия {r.version}</b><pre style={{ whiteSpace: 'pre-wrap' }}>{r.changelog}</pre><p class="note">{r.applySupported?"Для применения откройте существующую синюю кнопку обновлений внизу слева.":"Рабочая checkout-копия не заменяется. Нужен управляемый bootstrap и внешний updater-helper."}</p></section>)}</article>; }
