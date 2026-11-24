const $ = s => document.querySelector(s);
let limits={plugin:20000000,harness:512*1024**2};
let csrf = '', kind = 'plugin', rows = [], events = [], setup = false, pending;
const error = e => { $('#error').textContent = e instanceof Error ? e.message : String(e); };
async function api(url, options = {}) {
    const r = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body instanceof File ? { 'Content-Type': 'application/gzip' } : options.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...options.headers } });
    const x = await r.json();
    if (!r.ok)
        throw Error(x.error?.message ?? 'Запрос не выполнен');
    return x;
}
function node(tag, text, cls) {
    const e = document.createElement(tag);
    e.textContent = text;
    if (cls)
        e.className = cls;
    return e;
}
async function load() { const x = await api('/api/admin/releases'); rows = x.releases; events = x.events; render(); }
function confirm(text, action) { pending = action; $('#review-text').textContent = text; $('#review').showModal(); }
$('#cancel').onclick = () => { $('#review').close(); pending = undefined; };
$('#review').addEventListener('cancel', e => e.preventDefault());
$('#confirm').onclick = async () => {
    const action = pending;
    pending = undefined;
    $('#confirm').disabled = true;
    try {
        await action?.();
        $('#review').close();
        await load();
    }
    catch (e) {
        error(e);
    }
    finally {
        $('#confirm').disabled = false;
    }
};
function render() {
    const root = $('#releases');
    root.replaceChildren();
    $('#upload-box').hidden = kind === 'history';
    $('#title').textContent = kind === 'plugin' ? 'Плагины' : kind === 'harness' ? 'Обновления харнеса' : 'Журнал';
    if (kind === 'history') {
        for (const event of events) {
            const card = node('article', '', 'card');
            card.append(node('b', event.action), node('p', new Date(event.created).toLocaleString() + ' · версия #' + (event.release_id ?? '—'), 'meta'));
            root.append(card);
        }
        return;
    }
    for (const r of rows.filter(r => r.kind === kind)) {
        const card = node('article', '', 'card'), m = r.metadata;
        card.append(node('h2', r.name + ' · ' + r.version), node('span', r.status === 'draft' ? 'Черновик' : r.pluginHidden ? 'Скрыт весь плагин' : r.hidden ? 'Скрыта версия' : 'Опубликован', 'status'), node('p', r.platform + ' / ' + r.arch + ' · ' + r.channel + ' · ' + r.bytes + ' байт', 'meta'));
        const detail = node('details'), summary = node('summary', 'Изменения и метаданные');
        detail.append(summary, node('pre', JSON.stringify({ sha256: r.sha256, ...m }, null, 2)));
        card.append(detail);
        const actions = node('div', '', 'actions');
        for (const action of r.status === 'draft' ? ['publish'] : r.hidden ? ['show'] : ['hide']) {
            const label = action === 'publish' ? 'Опубликовать' : action === 'show' ? 'Показать версию' : 'Скрыть версию', button = node('button', label, action === 'publish' ? 'primary' : '');
            button.onclick = () => confirm(r.name + ' ' + r.version + '\n' + label + '?\n\n' + (m.changelog ?? '') + '\n\nУстановленные копии не изменяются.', () => api('/api/admin/releases/' + r.id + '/' + action, { method: 'POST', body: JSON.stringify({ confirm: true }) }));
            actions.append(button);
        }
        if (r.kind === 'plugin' && r.status === 'published') {
            for (const visible of [false, true]) {
                const b = node('button', visible ? 'Показать плагин целиком' : 'Скрыть плагин целиком');
                b.onclick = () => confirm((visible ? 'Показать' : 'Скрыть') + ' все версии ' + r.name + '?\nСкачивание опубликованных пакетов по известной ссылке сохраняется для отката; удалённого удаления нет.', () => api('/api/admin/plugins/' + encodeURIComponent(r.name) + '/visibility', { method: 'POST', body: JSON.stringify({ visible, confirm: true }) }));
                actions.append(b);
            }
        }
        card.append(actions);
        root.append(card);
    }
    if (!root.children.length)
        root.append(node('p', 'Версий пока нет.', 'note'));
}
for (const b of document.querySelectorAll('nav button'))
    b.onclick = () => {
        kind = b.dataset.filter;
        for (const x of document.querySelectorAll('nav button'))
            x.classList.toggle('on', x === b);
        render();
    };
async function ready() { const s = await api('/api/admin/session'); csrf = s.csrf;limits=s.limits??limits; $('#auth').hidden = true; $('#workspace').hidden = false; $('#logout').hidden = false; $('#password-open').hidden = false; await load(); }
$('#login').onsubmit = async (e) => {
    e.preventDefault();
    $('#error').textContent = '';
    const element = e.currentTarget, form = new FormData(element), username = form.get('username'), password = form.get('password');
    try {
        const result = await api(setup ? '/api/admin/bootstrap' : '/api/admin/login', { method: 'POST', headers: setup ? { Authorization: 'Bearer ' + form.get('bootstrap') } : {}, body: JSON.stringify({ username, password }) });
        csrf = result.csrf;
        element.reset();
        await ready();
    }
    catch (e) {
        error(e);
    }
};
$('#logout').onclick = async () => {
    try {
        await api('/api/admin/logout', { method: 'POST', body: '{}' });
        csrf = '';
        location.reload();
    }
    catch (e) {
        error(e);
    }
};
$('#upload').onsubmit = async (e) => {
    e.preventDefault();
    const element = e.currentTarget, file = new FormData(element).get('artifact');
    if (!(file instanceof File) || file.size > limits[kind]) {
        error('Архив превышает допустимый размер');
        return;
    }
    const button = element.querySelector('button');
    button.disabled = true;
    try {
        await api('/api/admin/uploads?kind=' + kind, { method: 'POST', body: file });
        element.reset();
        await load();
    }
    catch (e) {
        error(e);
    }
    finally {
        button.disabled = false;
    }
};
try {
    await ready();
}
catch {
    const x = await api('/api/admin/setup');
    setup = x.needed && x.enabled;
    $('#bootstrap-label').hidden = !setup;
    if (x.needed && !x.enabled) {
        $('#setup-note').textContent = 'Начальная настройка закрыта. Администратору сервера нужно задать отдельный одноразовый bootstrap-secret локально.';
        $('#login button').disabled = true;
    }
}

// Password values remain only in form/browser request memory; never rendered or logged.
$('#password-open').onclick = () => { $('#password-form').reset(); $('#password-dialog').showModal(); };
$('#password-cancel').onclick = () => $('#password-dialog').close();
$('#password-dialog').addEventListener('close', () => $('#password-form').reset());
$('#password-form').onsubmit = async (e) => {
 e.preventDefault(); const element=e.currentTarget, fields=new FormData(element), password=fields.get('new_password');
 if(typeof password!=='string'||password.length<12||password.length>128||password!==fields.get('confirm_password')){error('Пароли должны совпадать и содержать 12–128 символов');return;}
 const buttons=[...element.querySelectorAll('button')]; buttons.forEach(b=>b.disabled=true);
 try { await api('/api/admin/password',{method:'POST',body:JSON.stringify({password})}); $('#password-dialog').close(); $('#password-status').textContent='Пароль изменён. Остальные сеансы завершены.'; error(''); }
 catch(e){error(e);}
 finally{element.reset();buttons.forEach(b=>b.disabled=false);}
};
