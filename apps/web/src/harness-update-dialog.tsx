import { useEffect, useState } from 'preact/hooks';
import { api } from './api.js';
interface Managed {
    mode: string;
    current?: string;
    phase?: string;
    blocked?: boolean;
    reason?: string;
    operation?: {
        state: string;
        version?: string;
        error?: string;
    };
    lastError?: string;
}
interface Version {
    version: string;
    sha256: string;
    applySupported: boolean;
}
interface Review {
    reviewId: string;
    version: string;
    installedVersion: string | null;
    changelog: string;
    sha256: string;
    coreVersion: string;
    sdkVersion: string;
    nodeRange: string;
    dataSchema: string;
    platform: string;
    arch: string;
}
export function HarnessUpdateDialog({ onClose }: {
    onClose: () => void;
}) { const [m, setM] = useState<Managed>(), [versions, setVersions] = useState<Version[]>([]), [review, setReview] = useState<Review>(), [busy, setBusy] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState(''), [polling, setPolling] = useState(false); async function check() { setBusy(true); setError(''); try {
    const [status, feed] = await Promise.all([api<Managed>('/v1/updates/managed'), api<{
            configured: boolean;
            harness: Version[];
            error: string | null;
        }>('/v1/updates/check', { method: 'POST', body: {} })]);
    setM(status);
    setVersions(feed.harness);
    if (!feed.configured && !feed.error)
        setNotice('Источник и доверенный ключ ещё не настроены. Ключ не принимается из самого каталога.');
    if (feed.error)
        setError('Центр недоступен или подпись не подтверждена. Текущая версия работает.');
}
catch {
    setError('Проверка доступна владельцу; внешний updater должен быть подключён.');
}
finally {
    setBusy(false);
} } useEffect(() => { void check(); }, []); useEffect(() => { if (!polling)
    return; let active = true; const timer = setInterval(() => { void api<Managed>('/v1/updates/managed').then(status => { if (!active)
    return; setM(status); if (['committed', 'rolled_back', 'blocked', 'failed'].includes(status.operation?.state ?? '')) {
    setPolling(false);
    setNotice(status.operation?.state === 'committed' ? 'Новая версия запущена и проверена. Можно обновить страницу.' : status.operation?.state === 'rolled_back' ? 'Новая версия не прошла проверку; прежняя восстановлена.' : 'Нужна проверка владельцем; данные автоматически не удаляются.');
} }).catch(() => { if (active)
    setNotice('Ожидаем перезапуск и проверку версии. Повторное применение не запускается.'); }); }, 1000); return () => { active = false; clearInterval(timer); }; }, [polling]); async function inspect(version: string) { setBusy(true); setError(''); try {
    setReview(await api<Review>('/v1/updates/review', { method: 'POST', body: { version } }));
}
catch {
    setError('Пакет, подпись, совместимость или lifecycle не прошли проверку. Работающая версия не изменена.');
}
finally {
    setBusy(false);
} } async function apply() { if (!review)
    return; setBusy(true); setError(''); try {
    await api('/v1/updates/apply', { method: 'POST', body: { reviewId: review.reviewId, confirm: true } });
    setReview(undefined);
    setPolling(true);
    setNotice('Внешний updater принял запрос. Текущие задания должны завершиться; новые временно приостанавливаются.');
}
catch {
    setError('Подтверждённое обновление не принято. Повторите проверку пакета.');
}
finally {
    setBusy(false);
} } async function recover() { setBusy(true); try {
    await api('/v1/updates/recover', { method: 'POST', body: { confirm: true } });
    await check();
}
catch {
    setError('Безопасность восстановления не подтверждена. Пакеты и данные сохранены; PID не угадывается.');
}
finally {
    setBusy(false);
} } return <div class="overlay"><section class="dialog" role="dialog" aria-modal="true" aria-label="Обновления Sinty"><h2>Обновления Sinty</h2>{m?.mode === 'development' && <p class="note">{m.reason}</p>}{m?.current && <p>Установлено: {m.current} · {m.phase}</p>}{error && <p class="error">{error}</p>}{notice && <p class="note">{notice}</p>}{review ? <><h3>{review.installedVersion ?? 'не установлено'} → {review.version}</h3><p>Подпись и SHA-256 проверены: {review.sha256}</p><p>{review.platform}/{review.arch} · Node {review.nodeRange} · core {review.coreVersion} · SDK {review.sdkVersion}</p><p>Схема {review.dataSchema}; миграций нет. При занятости задачи не отменяются. Перед остановкой создаётся scoped backup.</p><pre style={{ whiteSpace: 'pre-wrap' }}>{review.changelog}</pre><button type="button" disabled={busy || polling} onClick={() => void apply()}>Подтвердить обновление и перезапуск</button><button type="button" disabled={busy} onClick={() => setReview(undefined)}>Назад</button></> : versions.map(v => <article key={v.version}><b>{v.version}</b>{m?.mode === 'managed' && !m.blocked && <button type="button" disabled={busy || polling || !v.applySupported} onClick={() => void inspect(v.version)}>Проверить пакет и изменения</button>}</article>)}{m?.blocked && <><p class="error">Восстановление заблокировано без доказательства безопасности. Данные и пакеты не удаляются.</p><button type="button" disabled={busy} onClick={() => void recover()}>Безопасно проверить восстановление</button></>}<footer class="dialog-actions"><button type="button" disabled={busy || polling} onClick={() => void check()}>Проверить снова</button>{m?.operation?.state === 'committed' && <button type="button" onClick={() => location.reload()}>Обновить страницу</button>}<button type="button" onClick={onClose}>Закрыть</button></footer></section></div>; }
