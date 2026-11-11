import { useEffect, useRef, useState } from "preact/hooks";
import { CSelect, CMultiSelect, Tog } from "./cselect";
import "./kit.css";

// Approved 46-specimen reference: SHA-256 0270a3ff0c8db65fb8472532595b98a6d6d736670484d29f1bbd8fd9f68ed059.
// Every interaction is local demo state. This module has no API client and never executes example commands.
function Segments({ items, initial = 0, accent }: { items: string[]; initial?: number; accent?: boolean }) {
  const [selected, setSelected] = useState(initial);
  return <div class={accent ? "seg accent" : "seg"}>{items.map((item, i) => <button key={item} type="button" class={selected === i ? "on" : ""} aria-pressed={selected === i} onClick={e => { e.stopPropagation(); setSelected(i); }}>{item}</button>)}</div>;
}
function DemoToggle({ initial, disabled, label }: { initial: boolean; disabled?: boolean; label: string }) {
  const [on, setOn] = useState(initial);
  return <span onClick={e => e.stopPropagation()}><Tog on={on} disabled={disabled} label={label} onClick={() => setOn(v => !v)} /></span>;
}
function SelectExamples() {
  const [model, setModel] = useState("deepseek/deepseek-flash");
  const [values, setValues] = useState(["deepseek-flash", "gemini-2.5"]);
  return <div class="subgrid">
    <div class="field"><span class="field-label">Селект с поиском <span class="sid">select.searchable</span></span>
      <CSelect label="Селект с поиском" searchable value={model} onChange={setModel} options={[
        { value: "deepseek/deepseek-flash", label: "deepseek/deepseek-flash", sub: "быстрый · по умолчанию" },
        { value: "openai/gpt-5", label: "openai/gpt-5", sub: "сильный ответ" },
        { value: "anthropic/claude-sonnet", label: "anthropic/claude-sonnet", sub: "длинный контекст" },
        { value: "google/gemini-2.5", label: "google/gemini-2.5", sub: "мультимодальный" },
      ]} /></div>
    <div class="field"><span class="field-label">Мультиселект <span class="sid">select.multi</span></span>
      <CMultiSelect label="Мультиселект" searchable values={values} onChange={setValues} options={[
        { value: "deepseek-flash", label: "deepseek-flash", sub: "быстрая модель" }, { value: "gemini-2.5", label: "gemini-2.5", sub: "мультимодальный" },
        { value: "whisper-1", label: "whisper-1", sub: "распознавание речи" }, { value: "claude-sonnet", label: "claude-sonnet", sub: "длинный контекст" },
      ]} /><span class="field-help">Выбранные значения становятся чипами внутри поля.</span></div>
  </div>;
}
function PaletteExample() {
  const [revision, refresh] = useState(0);
  useEffect(() => { const observer = new MutationObserver(() => refresh(v => v + 1)); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] }); return () => observer.disconnect(); }, []);
  const css = getComputedStyle(document.documentElement);
  const colors = [["Фон", "--bg"], ["Панель", "--panel"], ["Панель 2", "--panel-2"], ["Текст", "--text"], ["Приглушённый", "--muted"], ["Акцент", "--accent"], ["Граница", "--line"], ["Наведение", "--hover"]];
  return <div class="swatches" data-revision={revision}>{colors.map(([name, token]) => <div class="swatch" key={token}><div class="chip-color" style={{ background: `var(${token})` }} /><div class="meta"><b>{name}</b><span>{token} · {css.getPropertyValue(token!).trim()}</span></div></div>)}</div>;
}
function ActionMenu() {
  const [action, setAction] = useState("");
  return <div style={{ maxWidth: 280 }}><CSelect label="Демонстрационные действия" emptyLabel="Действия" value={action} onChange={setAction} options={[{ value: "rename", label: "Переименовать" }, { value: "duplicate", label: "Дублировать" }, { value: "delete", label: "Удалить (демо)" }]} />{action && <p class="field-help" role="status">Выбрано: {action}. Рабочие данные не изменены.</p>}</div>;
}

function Specimen0() { return <><div class="specimen-h"><div><h3>{"Палитра"}</h3><span class="sid">{"color.palette"}</span></div></div><p class="anatomy">{"Семантические цвета, а не сырые свитчи. Светлая и тёмная темы берут одни имена токенов."}</p><PaletteExample /></>; }

function Specimen1() { return <>
<div class="specimen-h"><div><h3>{"Типографика"}</h3><span class="sid">{"type.scale"}</span></div></div>
<p class="anatomy">{"Системный шрифт без внешних семейств. Моноширинный — только для кода, идентификаторов и счётчиков."}</p>
<div class="type-row"><span class="cap">{"28 / 650"}</span><div style="font-size:28px;font-weight:650;letter-spacing:-.03em;line-height:1.15">{"Заголовок экрана"}</div></div>
<div class="type-row"><span class="cap">{"18 / 650"}</span><div style="font-size:18px;font-weight:650;letter-spacing:-.02em">{"Заголовок карточки"}</div></div>
<div class="type-row"><span class="cap">{"14 / 400"}</span><div>{"Основной текст интерфейса. Межстрочный 1.45."}</div></div>
<div class="type-row"><span class="cap">{"13 / 600"}</span><div style="font-size:13px;font-weight:600">{"Подпись кнопки и строки списка"}</div></div>
<div class="type-row"><span class="cap">{"12 / 400"}</span><div style="font-size:12px;color:var(--muted)">{"Подсказка поля и вторичная строка"}</div></div>
<div class="type-row"><span class="cap">{"11 / 700"}</span><div style="font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)">{"Надзаголовок секции"}</div></div>
<div class="type-row"><span class="cap">{"13 mono"}</span><div style="font:13px/1.5 ui-monospace,Menlo,Consolas,monospace">{"button.primary · 12 400 ток."}</div></div>
</>; }

function Specimen2() { return <>
<div class="specimen-h"><div><h3>{"Отступы"}</h3><span class="sid">{"space.scale"}</span></div></div>
<p class="anatomy">{"Шаг 4px. Карточка 20px, список 8–10px, поля 12px, колонка контента 920px."}</p>
<div class="space-row">
<div class="space-item"><div class="space-box" style="width:4px;height:4px"></div><span class="cap">{"4"}</span></div>
<div class="space-item"><div class="space-box" style="width:8px;height:8px"></div><span class="cap">{"8"}</span></div>
<div class="space-item"><div class="space-box" style="width:12px;height:12px"></div><span class="cap">{"12"}</span></div>
<div class="space-item"><div class="space-box" style="width:16px;height:16px"></div><span class="cap">{"16"}</span></div>
<div class="space-item"><div class="space-box" style="width:20px;height:20px"></div><span class="cap">{"20"}</span></div>
<div class="space-item"><div class="space-box" style="width:24px;height:24px"></div><span class="cap">{"24"}</span></div>
<div class="space-item"><div class="space-box" style="width:32px;height:32px"></div><span class="cap">{"32"}</span></div>
<div class="space-item"><div class="space-box" style="width:48px;height:48px"></div><span class="cap">{"48"}</span></div>
</div>
</>; }

function Specimen3() { return <>
<div class="specimen-h"><div><h3>{"Скругления"}</h3><span class="sid">{"radius.scale"}</span></div></div>
<p class="anatomy">{"Поля и кнопки-капсулы — 10 и 999. Карточки 16, плитки 14, аккордеоны и меню 12."}</p>
<div class="radius-row">
<div class="radius-item"><div class="radius-demo" style="border-radius:6px"></div><span class="cap">{"6 · kbd"}</span></div>
<div class="radius-item"><div class="radius-demo" style="border-radius:8px"></div><span class="cap">{"8"}</span></div>
<div class="radius-item"><div class="radius-demo" style="border-radius:10px"></div><span class="cap">{"10 · поле"}</span></div>
<div class="radius-item"><div class="radius-demo" style="border-radius:12px"></div><span class="cap">{"12 · меню"}</span></div>
<div class="radius-item"><div class="radius-demo" style="border-radius:14px"></div><span class="cap">{"14 · плитка"}</span></div>
<div class="radius-item"><div class="radius-demo" style="border-radius:16px"></div><span class="cap">{"16 · карточка"}</span></div>
<div class="radius-item"><div class="radius-demo" style="border-radius:999px"></div><span class="cap">{"999 · капсула"}</span></div>
</div>
</>; }

function Specimen4() { return <>
<div class="specimen-h"><div><h3>{"Тени"}</h3><span class="sid">{"elevation"}</span></div></div>
<p class="anatomy">{"Плоскость интерфейса держится границей. Тень — у всплывающих слоёв и композера."}</p>
<div class="elev-row">
<div class="elev-item"><div class="elev-card"></div><span class="cap">{"карточка · граница"}</span></div>
<div class="elev-item"><div class="elev-card" style="box-shadow:0 1px 3px rgba(0,0,0,.12)"></div><span class="cap">{"сегмент on"}</span></div>
<div class="elev-item"><div class="elev-card" style="box-shadow:0 8px 28px var(--shadow)"></div><span class="cap">{"композер"}</span></div>
<div class="elev-item"><div class="elev-card" style="box-shadow:0 12px 40px var(--shadow)"></div><span class="cap">{"меню / тост"}</span></div>
</div>
</>; }

function Specimen5() { return <>
<div class="specimen-h"><div><h3>{"Границы"}</h3><span class="sid">{"border"}</span></div></div>
<p class="anatomy">{"Обычная линия — 1px var(--line). Акцент и ошибка подмешиваются в ту же границу, без толстых рамок."}</p>
<div class="border-demo">
<span style="border:1px solid var(--line)">{"обычная"}</span>
<span style="border:1px dashed var(--line)">{"пунктир · дропзона"}</span>
<span style="border:1px solid color-mix(in srgb, var(--accent) 45%, var(--line));box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent)">{"фокус"}</span>
<span style="border:1px solid color-mix(in srgb, var(--danger) 70%, var(--line))">{"ошибка"}</span>
</div>
</>; }

function Specimen6() { return <>
<div class="specimen-h"><div><h3>{"Размер иконок"}</h3><span class="sid">{"icon.size"}</span></div></div>
<p class="anatomy">{"Обводка 1.8, без сторонних наборов. 16px — кнопки и поля, 14px — поиск, 12px — чипы."}</p>
<div class="icon-row">
<div class="icon-item"><div class="icon-box" style="width:28px;height:28px"><svg width="12" height="12" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"></path></svg></div><span class="cap">{"12"}</span></div>
<div class="icon-item"><div class="icon-box" style="width:32px;height:32px"><svg width="14" height="14" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"></path></svg></div><span class="cap">{"14"}</span></div>
<div class="icon-item"><div class="icon-box" style="width:36px;height:36px"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"></path></svg></div><span class="cap">{"16"}</span></div>
<div class="icon-item"><div class="icon-box" style="width:44px;height:44px"><svg width="20" height="20" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"></path></svg></div><span class="cap">{"20"}</span></div>
<div class="icon-item"><div class="icon-box" style="width:48px;height:48px"><svg width="24" height="24" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"></path></svg></div><span class="cap">{"24"}</span></div>
</div>
</>; }

function Specimen7() { return <>
<div class="specimen-h"><div><h3>{"Кнопки"}</h3><span class="sid">{"button.primary · button.secondary · button.ghost · button.danger"}</span></div></div>
<p class="anatomy">{"Высота 36px, капсула. Primary несёт акцент и одно главное действие на экран. Secondary — нейтральная заливка панели. Ghost без заливки. Danger только для разрушительных действий."}</p>
<div class="stack">
<div>
<div class="cap" style="margin-bottom:8px">{"Основная · button.primary"}</div>
<div class="row">
<span class="state-cell"><span class="cap">{"Обычное"}</span><button type="button" class="btn primary">{"Сохранить"}</button></span>
<span class="state-cell"><span class="cap">{"Наведение"}</span><button type="button" class="btn primary is-hover">{"Сохранить"}</button></span>
<span class="state-cell"><span class="cap">{"Фокус"}</span><button type="button" class="btn primary is-focus" id="kit-focus-primary">{"Сохранить"}</button></span>
<span class="state-cell"><span class="cap">{"Нажатие"}</span><button type="button" class="btn primary is-active">{"Сохранить"}</button></span>
<span class="state-cell"><span class="cap">{"Загрузка"}</span><button type="button" class="btn primary"><i class="spin"></i>{"Сохранение"}</button></span>
<span class="state-cell"><span class="cap">{"Отключено"}</span><button type="button" class="btn primary" disabled={true}>{"Сохранить"}</button></span>
</div>
</div>
<div>
<div class="cap" style="margin-bottom:8px">{"Вторичная · button.secondary"}</div>
<div class="row">
<button type="button" class="btn">{"Отмена"}</button>
<button type="button" class="btn is-hover">{"Отмена"}</button>
<button type="button" class="btn is-active">{"Отмена"}</button>
<button type="button" class="btn" disabled={true}>{"Отмена"}</button>
</div>
</div>
<div>
<div class="cap" style="margin-bottom:8px">{"Прозрачная · button.ghost"}</div>
<div class="row">
<button type="button" class="btn ghost">{"Сбросить"}</button>
<button type="button" class="btn ghost is-hover">{"Сбросить"}</button>
<button type="button" class="btn ghost" disabled={true}>{"Сбросить"}</button>
</div>
</div>
<div>
<div class="cap" style="margin-bottom:8px">{"Опасная · button.danger"}</div>
<div class="row">
<button type="button" class="btn danger">{"Удалить"}</button>
<button type="button" class="btn danger is-hover">{"Удалить"}</button>
<button type="button" class="btn danger" disabled={true}>{"Удалить"}</button>
</div>
</div>
</div>
</>; }

function Specimen8() { return <>
<div class="specimen-h"><div><h3>{"Икон-кнопки"}</h3><span class="sid">{"button.icon"}</span></div></div>
<p class="anatomy">{"Квадрат 36×36, радиус 10. Только иконка, подпись через aria-label. Не путать с круглыми кнопками композера."}</p>
<div class="row">
<span class="state-cell"><span class="cap">{"Обычное"}</span><button type="button" class="ibtn" aria-label="Добавить"><svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"></path></svg></button></span>
<span class="state-cell"><span class="cap">{"Наведение"}</span><button type="button" class="ibtn is-hover" aria-label="Поиск"><svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.2"></circle><path d="m10.4 10.4 3 3"></path></svg></button></span>
<span class="state-cell"><span class="cap">{"Фокус"}</span><button type="button" class="ibtn is-focus" id="kit-focus-icon" aria-label="Ещё"><svg viewBox="0 0 16 16"><circle cx="4" cy="8" r="1.1" fill="currentColor" stroke="none"></circle><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"></circle><circle cx="12" cy="8" r="1.1" fill="currentColor" stroke="none"></circle></svg></button></span>
<span class="state-cell"><span class="cap">{"Отключено"}</span><button type="button" class="ibtn" disabled={true} aria-label="Копировать"><svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="7" height="8" rx="1.4"></rect><path d="M4 10.5H3.5A1.5 1.5 0 0 1 2 9V3.5A1.5 1.5 0 0 1 3.5 2H9A1.5 1.5 0 0 1 10.5 3.5V4"></path></svg></button></span>
</div>
</>; }

function Specimen9() { return <>
<div class="specimen-h"><div><h3>{"Сегменты"}</h3><span class="sid">{"control.segmented"}</span></div></div>
<p class="anatomy">{"Капсула с взаимно исключающим выбором. Нейтральный вариант — для вида. Акцентный — для короткого фильтра вроде периода."}</p>
<div class="stack">
<Segments items={["Светлая", "Тёмная", "Как в системе"]} initial={0} accent={false} />
<Segments items={["Сегодня", "7 дней", "30 дней", "Всё"]} initial={1} accent={true} />
</div>
</>; }

function Specimen10() { return <>
<div class="specimen-h"><div><h3>{"Вкладки и пилюли"}</h3><span class="sid">{"tab.pills"}</span></div></div>
<p class="anatomy">{"Те же сегменты, но для подвкладок внутри карточки: список / добавить, роли / права."}</p>
<Segments items={["Установленные", "Каталог", "Добавить"]} initial={0} accent={false} />
</>; }

function Specimen11() { return <>
<div class="specimen-h"><div><h3>{"Поля ввода"}</h3><span class="sid">{"input.text · input.secret · input.textarea · input.number"}</span></div></div>
<p class="anatomy">{"Радиус 10, фон панели 2, фокус — тонкое зелёное кольцо. Поле с маской только демонстрирует вид секрета: ничего не собирается и не отправляется."}</p>
<div class="subgrid">
<label class="field">
<span class="field-label">{"Текст "}<span class="sid">{"input.text"}</span></span>
<input class="in" type="text" defaultValue="Dbr" aria-label="Пример текстового поля" />
</label>
<label class="field">
<span class="field-label">{"Наведение"}</span>
<input class="in" type="text" defaultValue="seo" style="background:color-mix(in srgb, var(--hover) 70%, var(--panel-2))" aria-label="Поле в состоянии наведения" />
</label>
<label class="field">
<span class="field-label">{"Фокус"}</span>
<input class="in is-focus" type="text" defaultValue="Агент для SEO-задач" aria-label="Поле в состоянии фокуса" />
</label>
<label class="field">
<span class="field-label">{"Ошибка"}</span>
<input class="in is-error" type="text" defaultValue="" placeholder="обязательное поле" aria-invalid="true" aria-label="Поле с ошибкой" />
<span class="field-help" style="color:var(--danger)">{"Укажите имя агента"}</span>
</label>
<label class="field">
<span class="field-label">{"Отключено"}</span>
<input class="in" type="text" defaultValue="нельзя изменить" disabled={true} />
</label>
<label class="field">
<span class="field-label">{"Маска секрета "}<span class="sid">{"input.secret"}</span></span>
<input class="in" type="text" defaultValue="••••••••••••" autoComplete="off" spellcheck={false} aria-label="Демонстрация маски, не секрет" />
<span class="field-help">{"Визуальная маска. Не пароль и не ключ — демо-строка из точек."}</span>
</label>
<label class="field">
<span class="field-label">{"Число "}<span class="sid">{"input.number"}</span></span>
<input class="in" type="number" defaultValue="150000" aria-label="Пример числового поля" />
<span class="field-help">{"Потолок сводки, ток. · пример"}</span>
</label>
<label class="field">
<span class="field-label">{"Число с единицей"}</span>
<input class="in" type="number" defaultValue="90" aria-label="Секунды тишины, пример" />
<span class="field-help">{"Секунд тишины "}<span class="unit">{"с"}</span>{" · пример"}</span>
</label>
</div>
<label class="field" style="margin-top:12px">
<span class="field-label">{"Текстовая область "}<span class="sid">{"input.textarea"}</span></span>
<textarea class="in" rows={3} aria-label="Пример текстовой области" defaultValue={"Ты — SEO-агент Syntet.\nПиши коротко, с фактами и ссылками."} />
</label>
</>; }

function Specimen12() { return <><div class="specimen-h"><div><h3>{"Селекты"}</h3><span class="sid">{"select.searchable · select.multi"}</span></div></div><p class="anatomy">{"Кастомный список, не нативный select. Поиск сверху, у опции может быть подзаголовок. Стрелки листают, Enter выбирает, Esc закрывает."}</p><SelectExamples /></>; }

function Specimen13() { return <>
<div class="specimen-h"><div><h3>{"Флажки и радио"}</h3><span class="sid">{"input.checkbox · input.radio"}</span></div></div>
<p class="anatomy">{"Чекбокс — множественный выбор прав и списков. Радио — один вариант из группы."}</p>
<div class="subgrid">
<div class="col">
<span class="cap">{"Чекбокс"}</span>
<label class="check"><input type="checkbox" defaultChecked={true} />{" Смотреть"}</label>
<label class="check"><input type="checkbox" />{" Править"}</label>
<label class="check is-disabled"><input type="checkbox" disabled={true} />{" Удалять (нет прав)"}</label>
</div>
<div class="col">
<span class="cap">{"Радио"}</span>
<label class="radio"><input type="radio" name="demo-radio" defaultChecked={true} />{" Разрешить"}</label>
<label class="radio"><input type="radio" name="demo-radio" />{" Спрашивать"}</label>
<label class="radio"><input type="radio" name="demo-radio" />{" Запретить"}</label>
</div>
</div>
</>; }

function Specimen14() { return <>
<div class="specimen-h"><div><h3>{"Переключатель"}</h3><span class="sid">{"control.toggle"}</span></div></div>
<p class="anatomy">{"Вкл/выкл без подписи внутри. Зелёный трек — включено. Стоит справа от названия настройки."}</p>
<div class="row">
<span class="state-cell"><span class="cap">{"Выкл"}</span><DemoToggle initial={false} disabled={false} label="Выключено" /></span>
<span class="state-cell"><span class="cap">{"Вкл"}</span><DemoToggle initial={true} disabled={false} label="Включено" /></span>
<span class="state-cell"><span class="cap">{"Отключено"}</span><button type="button" class="tog on is-disabled" disabled={true} aria-label="Недоступно"></button></span>
</div>
</>; }

function Specimen15() { return <>
<div class="specimen-h"><div><h3>{"Слайдер"}</h3><span class="sid">{"input.slider"}</span></div></div>
<p class="anatomy">{"Непрерывное значение в диапазоне. Рядом — числовой счётчик."}</p>
<div class="slider-wrap">
<div class="meter top"><span>{"Вес кэшированного токена"}</span><b id="kit-slider-val">{"0.10"}</b></div>
<input id="kit-demo-slider" type="range" min="0" max="100" defaultValue="10" aria-label="Вес кэшированного токена, пример" />
<span class="field-help">{"Пример: 0.10 ≈ скидка на чтение кэша. Не живой параметр."}</span>
</div>
</>; }

function Specimen16() { return <>
<div class="specimen-h"><div><h3>{"Группа полей"}</h3><span class="sid">{"input.group"}</span></div></div>
<p class="anatomy">{"Склейка поля с приставкой или кнопкой без зазора. Общий контур 10px."}</p>
<div class="stack">
<div class="igroup">
<span class="addon">{"npx"}</span>
<input class="in" type="text" defaultValue="skills add владелец/репозиторий" aria-label="Пример командной строки" />
<button type="button" class="btn">{"→"}</button>
</div>
</div>
</>; }

function Specimen17() { return <>
<div class="specimen-h"><div><h3>{"Поле поиска"}</h3><span class="sid">{"input.search"}</span></div></div>
<p class="anatomy">{"Текстовое поле с иконкой слева. Фильтрует списки на месте, без отдельной кнопки «Найти», если результатов мало."}</p>
<div class="searchbox">
<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6"></circle><path d="M10.5 10.5 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"></path></svg>
<input class="in" type="search" placeholder="Поиск плагинов" aria-label="Пример поля поиска" />
</div>
</>; }

function Specimen18() { return <>
<div class="specimen-h"><div><h3>{"Бейджи, чипы и теги"}</h3><span class="sid">{"badge · chip · tag"}</span></div></div>
<p class="anatomy">{"Бейдж — статус рядом с именем. Чип — выбираемый фильтр или модель. Тег — съёмная метка."}</p>
<div class="stack">
<div class="row">
<span class="badge">{"ключ задан"}</span>
<span class="badge fresh">{"свежий"}</span>
<span class="badge ok">{"запущен"}</span>
<span class="badge warn">{"нет тулов"}</span>
<span class="badge err">{"ошибка старта"}</span>
<span class="badge info">{"12 тул."}</span>
</div>
<div class="chips">
<button type="button" class="chip on" data-chip=""><i></i>{"deepseek/deepseek-flash"}</button>
<button type="button" class="chip on" data-chip=""><i></i>{"google/gemini-2.5"}</button>
<button type="button" class="chip" data-chip=""><i></i>{"openai/whisper-1"}</button>
<span class="chip on">{"seo "}<button type="button" class="x" aria-label="Убрать тег">{"×"}</button></span>
</div>
</div>
</>; }

function Specimen19() { return <>
<div class="specimen-h"><div><h3>{"Тултип"}</h3><span class="sid">{"tooltip"}</span></div></div>
<p class="anatomy">{"Короткая подсказка над контролом. Не дублирует видимый текст и не несёт критичное действие."}</p>
<div class="row">
<span class="tip">
<button type="button" class="btn">{"Статус агента"}</button>
<span class="bubble">{"Свободен · пример"}</span>
</span>
</div>
</>; }

function Specimen20() { return <>
<div class="specimen-h"><div><h3>{"Аватары"}</h3><span class="sid">{"avatar.24 · avatar.36 · avatar.48 · avatar.72"}</span></div></div>
<p class="anatomy">{"Только круг, без овалов. Базовый размер интерфейса — 36px. Инициалы, если нет изображения. Группа слегка накладывается."}</p>
<div class="row" style="align-items:flex-end">
<span class="state-cell"><span class="cap">{"24"}</span><span class="av av24" style="background:#6366f1">{"С"}</span></span>
<span class="state-cell"><span class="cap">{"36"}</span><span class="av av36" style="background:#0ea5e9">{"D"}</span></span>
<span class="state-cell"><span class="cap">{"48"}</span><span class="av av48" style="background:#0d9488">{"MK"}</span></span>
<span class="state-cell"><span class="cap">{"72"}</span><span class="av av72" style="background:#6366f1">{"D"}</span></span>
<span class="state-cell"><span class="cap">{"группа"}</span>
<span class="av-group">
<span class="av av36" style="background:#6366f1">{"С"}</span>
<span class="av av36" style="background:#0ea5e9">{"D"}</span>
<span class="av av36" style="background:#f97316">{"К"}</span>
</span>
</span>
</div>
</>; }

function Specimen21() { return <>
<div class="specimen-h"><div><h3>{"Точка статуса"}</h3><span class="sid">{"status.dot"}</span></div></div>
<p class="anatomy">{"8px круг рядом с подписью. Не заменяет бейдж, если нужен текст причины."}</p>
<div class="row">
<span class="sdot-row"><i class="sdot ok"></i>{" свободен"}</span>
<span class="sdot-row"><i class="sdot busy"></i>{" занят"}</span>
<span class="sdot-row"><i class="sdot warn"></i>{" ждёт подтверждения"}</span>
<span class="sdot-row"><i class="sdot err"></i>{" ошибка"}</span>
<span class="sdot-row"><i class="sdot"></i>{" выключен"}</span>
</div>
</>; }

function Specimen22() { return <>
<div class="specimen-h"><div><h3>{"Спиннер и скелетон"}</h3><span class="sid">{"spinner · skeleton"}</span></div></div>
<p class="anatomy">{"Спиннер — короткое ожидание действия. Скелетон — каркас списка, пока нет данных."}</p>
<div class="row">
<span class="state-cell"><span class="cap">{"Спиннер"}</span><i class="spin" aria-label="Загрузка"></i></span>
<span class="state-cell" style="min-width:220px"><span class="cap">{"Скелетон строки"}</span>
<div class="row">
<div class="skel" style="width:36px;height:36px;border-radius:50%"></div>
<div style="display:grid;gap:6px;flex:1">
<div class="skel" style="height:10px;width:140px"></div>
<div class="skel" style="height:8px;width:96px"></div>
</div>
</div>
</span>
</div>
</>; }

function Specimen23() { return <>
<div class="specimen-h"><div><h3>{"Прогресс и метр токенов"}</h3><span class="sid">{"progress · meter.tokens"}</span></div></div>
<p class="anatomy">{"Линейный прогресс для загрузки. Метр токенов показывает долю окна или бюджета хода. Цифры — пример."}</p>
<div class="stack">
<div>
<div class="cap" style="margin-bottom:6px">{"Обычный"}</div>
<div class="progress" aria-valuenow={42} aria-valuemin={0} aria-valuemax={100}><i style="width:42%"></i></div>
</div>
<div>
<div class="cap" style="margin-bottom:6px">{"Внимание"}</div>
<div class="progress warn"><i style="width:82%"></i></div>
</div>
<div>
<div class="cap" style="margin-bottom:6px">{"Превышен"}</div>
<div class="progress err"><i style="width:100%"></i></div>
</div>
<div class="meter">
<div class="top"><span>{"Бюджет хода"}</span><span>{"12 400 / 150 000 · пример"}</span></div>
<div class="progress"><i style="width:8%"></i></div>
</div>
</div>
</>; }

function Specimen24() { return <>
<div class="specimen-h"><div><h3>{"Клавиатурные подсказки"}</h3><span class="sid">{"kbd"}</span></div></div>
<p class="anatomy">{"Клавиша как бейдж с лёгкой нижней гранью. Стоит в подписи композера и меню."}</p>
<div class="row">
<span><kbd>{"Enter"}</kbd>{" отправить"}</span>
<span><kbd>{"Shift"}</kbd>
<kbd>{"Enter"}</kbd>{" новая строка"}</span>
<span><kbd>{"Esc"}</kbd>{" закрыть"}</span>
</div>
</>; }

function Specimen25() { return <>
<div class="specimen-h"><div><h3>{"Разделители"}</h3><span class="sid">{"divider"}</span></div></div>
<p class="anatomy">{"Горизонтальная линия режет секции настройки. Вертикальная — штучные панели инструментов."}</p>
<div class="stack">
<div>{"Над линией"}<hr class="divider" />{"Под линией"}</div>
<div class="row">{"Слева "}<i class="divider v"></i>{" Справа"}</div>
</div>
</>; }

function Specimen26() { return <>
<div class="specimen-h"><div><h3>{"Ссылки"}</h3><span class="sid">{"link"}</span></div></div>
<p class="anatomy">{"Текстовая навигация внутри подсказок. Цвет текста, не акцентный зелёный."}</p>
<div class="row">
<a class="link" href="#policy" id="kit-demo-link">{"Политика"}</a>
<a class="link muted" href="#memory">{"Память и контекст"}</a>
<a class="link is-disabled" href="#none" aria-disabled="true">{"Недоступно"}</a>
</div>
</>; }

function Specimen27() { return <>
<div class="specimen-h"><div><h3>{"Хлебные крошки"}</h3><span class="sid">{"nav.breadcrumb"}</span></div></div>
<p class="anatomy">{"Проект / чат плюс пилюля агента и точка статуса. Последний сегмент не кликабелен."}</p>
<div class="crumbs">
<button type="button">{"первый"}</button>
<span class="cap">{"/"}</span>
<span class="cur">{"дола 2"}</span>
<span class="chip" style="cursor:default"><span class="av av24" style="background:#a78bfa;width:22px;height:22px">{"С"}</span>{" Синтия"}</span>
<span class="sdot-row"><i class="sdot ok"></i>{" свободен"}</span>
</div>
</>; }

function Specimen28() { return <>
<div class="specimen-h"><div><h3>{"Аккордеон"}</h3><span class="sid">{"disclosure"}</span></div></div>
<p class="anatomy">{"Скрывает второстепенные группы настроек. Шеврон ▸ поворачивается при открытии."}</p>
<div class="stack">
<details class="acc" open={true}>
<summary>{"Бюджет хода"}</summary>
<div class="body">{"Открытое состояние. Внутри — поля и подсказки, не новый экран."}</div>
</details>
<details class="acc">
<summary>{"Пороги и эскалация"}</summary>
<div class="body">{"Скрытое содержимое. Клик по заголовку раскрывает блок."}</div>
</details>
</div>
</>; }

function Specimen29() { return <><div class="specimen-h"><div><h3>{"Меню"}</h3><span class="sid">{"menu.dropdown"}</span></div></div><p class="anatomy">{"Выпадающий список действий. Esc и клик снаружи закрывают. Опасный пункт в конце."}</p><ActionMenu /></>; }

function Specimen30() { return <>
<div class="specimen-h"><div><h3>{"Уведомления"}</h3><span class="sid">{"toast · alert.info · alert.warning · alert.error · alert.success"}</span></div></div>
<p class="anatomy">{"Тост — короткий подтверждение действия, снизу справа. Инлайн-блоки остаются в потоке формы."}</p>
<div class="stack">
<div class="row"><button type="button" class="btn primary" id="kit-toast-btn">{"Показать тост"}</button></div>
<div class="alert info"><b>{"Информация"}</b>{"Снимки промпта последних шагов модели. Пример текста."}</div>
<div class="alert ok"><b>{"Успех"}</b>{"Навык записан (мок). На рабочий Sinty ничего не сохранено."}</div>
<div class="alert warn"><b>{"Внимание"}</b>{"Пустой ключ не затирает уже записанный."}</div>
<div class="alert err"><b>{"Ошибка"}</b>{"Не удалось запустить MCP (пример статуса, не живое соединение)."}</div>
</div>
</>; }

function Specimen31() { return <>
<div class="specimen-h"><div><h3>{"Пустое состояние и ошибка"}</h3><span class="sid">{"state.empty · state.error"}</span></div></div>
<p class="anatomy">{"Пустой список предлагает следующее действие. Ошибка объясняет, что случилось, без технических следов стека."}</p>
<div class="subgrid">
<div class="empty">
<b>{"Навыков пока нет"}</b>
<span>{"Добавьте навык из папки, zip или командой."}</span>
<div style="margin-top:12px"><button type="button" class="btn primary">{"Добавить навык"}</button></div>
</div>
<div class="errbox">
<b>{"Не удалось загрузить каталог"}</b>
<span>{"Проверьте сеть и повторите. Пример, не живая ошибка."}</span>
<div style="margin-top:12px"><button type="button" class="btn">{"Повторить"}</button></div>
</div>
</div>
</>; }

function Specimen32() { return <>
<div class="specimen-h"><div><h3>{"Пагинация"}</h3><span class="sid">{"pagination"}</span></div></div>
<p class="anatomy">{"Короткая лента «назад / диапазон / дальше» под таблицей вызовов."}</p>
<div class="pager">
<button type="button" class="btn ghost" id="kit-page-prev">{"Назад"}</button>
<span class="note cap" id="kit-page-label">{"1–4 из 142 · пример"}</span>
<button type="button" class="btn ghost" id="kit-page-next">{"Дальше"}</button>
</div>
</>; }

function Specimen33() { return <>
<div class="specimen-h"><div><h3>{"Таблица"}</h3><span class="sid">{"table.header · table.cell"}</span></div></div>
<p class="anatomy">{"Приглушённые заголовки 12px. Числа выровнены вправо и моноширинно через tabular-nums. Строка подсвечивается при наведении."}</p>
<div style="overflow:auto">
<table class="data">
<thead>
<tr><th>{"Задача"}</th><th>{"Агент"}</th><th class="num">{"Запросы"}</th><th class="num">{"Токены"}</th></tr>
</thead>
<tbody>
<tr><td>{"SEO-аудит выдачи"}</td><td>{"Dbr"}</td><td class="num">{"48"}</td><td class="num">{"706 610"}</td></tr>
<tr><td>{"Монтаж клипа"}</td><td>{"Синтия"}</td><td class="num">{"31"}</td><td class="num">{"471 200"}</td></tr>
<tr><td>{"Бриф по ключу"}</td><td>{"Dbr"}</td><td class="num">{"24"}</td><td class="num">{"330 230"}</td></tr>
</tbody>
</table>
</div>
<p class="field-help" style="margin-top:8px">{"Строки — демонстрационные, не телеметрия."}</p>
</>; }

function Specimen34() { return <>
<div class="specimen-h"><div><h3>{"Вложение и загрузка"}</h3><span class="sid">{"file.chip · upload.dropzone"}</span></div></div>
<p class="anatomy">{"Чип файла в композере и пунктирная зона сброса. Здесь только вид: файлы не загружаются."}</p>
<div class="stack">
<div class="row">
<span class="file-chip"><span class="ico">{"PNG"}</span>{" кадр-01.png "}<button type="button" class="x" aria-label="Убрать файл">{"×"}</button></span>
<span class="file-chip"><span class="ico">{"MP4"}</span>{" клип.mp4 "}<button type="button" class="x" aria-label="Убрать файл">{"×"}</button></span>
</div>
<div class="drop" id="kit-dropzone">{"Перетащите файлы сюда или нажмите, чтобы выбрать"}<br  /><span class="cap">{"Демо: загрузки нет"}</span></div>
</div>
</>; }

function Specimen35() { return <>
<div class="specimen-h"><div><h3>{"Плейсхолдеры медиа"}</h3><span class="sid">{"media.placeholder"}</span></div></div>
<p class="anatomy">{"Ряд равной высоты: ширина считается из натурального соотношения сторон. Видео помечается кнопкой воспроизведения."}</p>
<div class="media-row">
<div class="ph-media r169">{"16:9 · изображение"}</div>
<div class="ph-media r43">{"4:3 · кадр"}</div>
<div class="ph-media r11">{"1:1 · квадрат"}</div>
<div class="ph-media r916">{"9:16 · сторис"}</div>
<div class="ph-media r169"><span class="play" aria-hidden="true">{"▶"}</span>{"16:9 · видео"}</div>
</div>
</>; }

function Specimen36() { return <>
<div class="specimen-h"><div><h3>{"Строка чата"}</h3><span class="sid">{"chat.row"}</span></div></div>
<p class="anatomy">{"Аватар 36, название и обрезанный превью-подзаголовок. Активная строка чуть залита."}</p>
<div class="col" style="max-width:360px;background:var(--panel-2);border:1px solid var(--line);border-radius:14px;padding:6px">
<button type="button" class="list-row"><span class="av av36" style="background:#a78bfa">{"С"}</span><span class="list-meta"><span class="list-title">{"дола"}</span><span class="list-sub">{"голова ещё большая…"}</span></span></button>
<button type="button" class="list-row on"><span class="av av36" style="background:#a78bfa">{"С"}</span><span class="list-meta"><span class="list-title">{"дола 2"}</span><span class="list-sub">{"пропорции 9 голов…"}</span></span></button>
<button type="button" class="list-row is-hover"><span class="av av36" style="background:#38bdf8">{"Т"}</span><span class="list-meta"><span class="list-title">{"Тест 10"}</span><span class="list-sub">{"ок"}</span></span></button>
</div>
</>; }

function Specimen37() { return <>
<div class="specimen-h"><div><h3>{"Плитка агента"}</h3><span class="sid">{"agent.tile"}</span></div></div>
<p class="anatomy">{"Круг 36, имя и специализация. Выбранная плитка подсвечивает границу акцентом."}</p>
<div class="tile-grid">
<div class="tile"><span class="av av36" style="background:#6366f1">{"С"}</span><span class="txt"><b>{"Синтия"}</b><span>{"видео · монтаж"}</span></span></div>
<div class="tile on"><span class="av av36" style="background:#0ea5e9">{"D"}</span><span class="txt"><b>{"Dbr"}</b><span>{"seo"}</span></span></div>
</div>
</>; }

function Specimen38() { return <>
<div class="specimen-h"><div><h3>{"Плитка плагина"}</h3><span class="sid">{"plugin.tile"}</span></div></div>
<p class="anatomy">{"Как карточка агента, но справа тумблер и необязательный мини-бейдж «у всех»."}</p>
<div class="tile-grid">
<div class="tile on"><span class="av av36" style="background:var(--hover);color:var(--text)">{"W"}</span><span class="txt"><b>{"tool-web"}</b><span>{"0.1.0 · bundled · Поиск и fetch"}</span></span><span class="badge fresh">{"у всех"}</span><DemoToggle initial={true} disabled={false} label="Плагин включён" /></div>
<div class="tile"><span class="av av36" style="background:var(--hover);color:var(--text)">{"H"}</span><span class="txt"><b>{"hyperframes"}</b><span>{"клипы и монтаж"}</span></span><span class="badge">{"не у всех"}</span><DemoToggle initial={false} disabled={false} label="Плагин выключен" /></div>
</div>
</>; }

function Specimen39() { return <>
<div class="specimen-h"><div><h3>{"Статус MCP"}</h3><span class="sid">{"mcp.status"}</span></div></div>
<p class="anatomy">{"Плитка подключения плюс текстовый статус. Подписи — примеры состояний интерфейса, не живые аккаунты провайдеров."}</p>
<div class="tile-grid">
<div class="tile on"><span class="av av36" style="background:var(--hover);color:var(--text)">{"G"}</span><span class="txt"><b>{"github"}</b><span>{"mcp-stdio · home · 12 тул. · пример"}</span></span><span class="badge ok">{"запущен"}</span></div>
<div class="tile on"><span class="av av36" style="background:var(--hover);color:var(--text)">{"P"}</span><span class="txt"><b>{"postgres"}</b><span>{"mcp-stdio · home · нет тулов · пример"}</span></span><span class="badge err">{"ошибка старта"}</span></div>
<div class="tile"><span class="av av36" style="background:var(--hover);color:var(--text)">{"F"}</span><span class="txt"><b>{"filesystem"}</b><span>{"mcp-stdio · home · пример"}</span></span><span class="badge">{"выключен"}</span></div>
</div>
</>; }

function Specimen40() { return <>
<div class="specimen-h"><div><h3>{"Пузыри чата"}</h3><span class="sid">{"chat.bubble.user · chat.bubble.agent · chat.bubble.system"}</span></div></div>
<p class="anatomy">{"Сообщение пользователя справа, заливка --user. Ответ агента — карточка панели. Система — тихая строка по центру."}</p>
<div class="bubbles">
<div class="bubble-user">{"Собери бриф по ключу «ремонт квартир москва»"}</div>
<div>
<div class="who"><span class="av av24" style="background:#0ea5e9">{"D"}</span><strong>{"Dbr"}</strong>{" seo"}</div>
<div class="bubble-agent">{"Соберу интент, конкурентов и черновую структуру. Это пример текста ответа, не живая генерация."}</div>
</div>
<div class="bubble-system">{"Ход остановлен супервизором · пример"}</div>
</div>
</>; }

function Specimen41() { return <>
<div class="specimen-h"><div><h3>{"Блок кода"}</h3><span class="sid">{"code.block"}</span></div></div>
<p class="anatomy">{"Шапка с языком и кнопкой копирования. Моноширинный текст, фон страницы внутри карточки."}</p>
<div class="code">
<div class="cap"><span>{"AGENTS.md"}</span><button type="button" class="btn sm ghost" id="kit-copy-code">{"Копировать"}</button></div>
<pre id="kit-code-sample">{"Ты — SEO-агент Syntet.\nПиши коротко, с фактами и ссылками.\nНе выдумывай позиции в выдаче."}</pre>
</div>
</>; }

function Specimen42() { return <>
<div class="specimen-h"><div><h3>{"Вызов инструмента"}</h3><span class="sid">{"tool.call"}</span></div></div>
<p class="anatomy">{"Одна анатомия на четыре вида: свёрнут, раскрыт с аргументами, результат, ошибка."}</p>
<div class="stack">
<details class="tool">
<summary>{"web.search "}<span class="cap">{"0.4 с · пример"}</span></summary>
<div class="body">{"свернуто по умолчанию — раскройте соседний блок"}</div>
</details>
<details class="tool" open={true}>
<summary>{"web.search "}<span class="cap">{"аргументы"}</span></summary>
<div class="body">{"{ \"query\": \"ремонт квартир москва\", \"count\": 8 }"}</div>
</details>
<details class="tool" open={true}>
<summary>{"web.search "}<span class="okt">{"результат"}</span></summary>
<div class="body">{"8 ссылок · пример выдачи, не живой поиск"}</div>
</details>
<details class="tool err" open={true}>
<summary>{"web.read "}<span class="ert">{"ошибка"}</span></summary>
<div class="body">{"timeout · страница не ответила за 20 с · пример"}</div>
</details>
</div>
</>; }

function Specimen43() { return <>
<div class="specimen-h"><div><h3>{"Одобрение"}</h3><span class="sid">{"approval"}</span></div></div>
<p class="anatomy">{"Запрос на действие с побочным эффектом. Только демонстрация контролов: решения никуда не уходят."}</p>
<div class="approve">
<div class="hd"><span class="badge warn">{"спрашивать"}</span><b>{"shell.run"}</b></div>
<div class="field-help">{"npm test в папке проекта · пример вызова, не выполняется"}</div>
<div class="row">
<button type="button" class="btn primary" data-toast="Разрешено на этот раз (мок)">{"Разрешить"}</button>
<button type="button" class="btn" data-toast="Разрешено до конца сессии (мок)">{"На эту сессию"}</button>
<button type="button" class="btn ghost" data-toast="Отклонено (мок)">{"Запретить"}</button>
</div>
</div>
</>; }

function Specimen44() { return <>
<div class="specimen-h"><div><h3>{"Композер"}</h3><span class="sid">{"composer"}</span></div></div>
<p class="anatomy">{"Капсула: плюс, поле, микрофон, отправка. Во время хода отправка сменяется стопом. Запись подсвечивает микрофон."}</p>
<div class="stack">
<div>
<div class="cap" style="margin-bottom:8px">{"Пустой"}</div>
<div class="composer">
<button type="button" class="cicon" aria-label="Вложить">{"+"}</button>
<textarea placeholder="Сообщение агенту" aria-label="Поле композера" defaultValue={""} />
<button type="button" class="cicon" aria-label="Голос"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="6" y="2" width="4" height="7" rx="2"></rect><path d="M4 8a4 4 0 0 0 8 0" fill="none" stroke="currentColor" strokeWidth="1.4"></path><path d="M8 12v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"></path></svg></button>
<button type="button" class="cicon send" disabled={true} aria-label="Отправить">{"↑"}</button>
</div>
</div>
<div>
<div class="cap" style="margin-bottom:8px">{"Готов к отправке"}</div>
<div class="composer">
<button type="button" class="cicon" aria-label="Вложить">{"+"}</button>
<textarea aria-label="Поле композера с текстом" defaultValue={"Собери бриф по ключу"} />
<button type="button" class="cicon" aria-label="Голос"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="6" y="2" width="4" height="7" rx="2"></rect><path d="M4 8a4 4 0 0 0 8 0" fill="none" stroke="currentColor" strokeWidth="1.4"></path><path d="M8 12v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"></path></svg></button>
<button type="button" class="cicon send" aria-label="Отправить" data-toast="Сообщение поставлено в очередь (мок)">{"↑"}</button>
</div>
</div>
<div>
<div class="cap" style="margin-bottom:8px">{"Запись"}</div>
<div class="composer">
<button type="button" class="cicon" aria-label="Вложить">{"+"}</button>
<textarea placeholder="Идёт запись…" aria-label="Запись голоса" defaultValue={""} />
<button type="button" class="cicon rec" aria-label="Остановить запись"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="6" y="2" width="4" height="7" rx="2"></rect></svg></button>
<button type="button" class="cicon send" disabled={true} aria-label="Отправить">{"↑"}</button>
</div>
</div>
<div>
<div class="cap" style="margin-bottom:8px">{"Генерация · стоп"}</div>
<div class="composer">
<button type="button" class="cicon" aria-label="Вложить">{"+"}</button>
<textarea placeholder="Агент отвечает…" aria-label="Композер во время хода" defaultValue={""} />
<button type="button" class="cicon" aria-label="Голос"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="6" y="2" width="4" height="7" rx="2"></rect><path d="M4 8a4 4 0 0 0 8 0" fill="none" stroke="currentColor" strokeWidth="1.4"></path><path d="M8 12v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"></path></svg></button>
<button type="button" class="cicon stop" aria-label="Остановить" data-toast="Ход остановлен (мок)">{"■"}</button>
</div>
</div>
<div class="cap"><kbd>{"Enter"}</kbd>{" отправить · "}<kbd>{"Shift"}</kbd>
<kbd>{"Enter"}</kbd>{" новая строка"}</div>
</div>
</>; }

function Specimen45() { return <>
<div class="specimen-h"><div><h3>{"Расход токенов"}</h3><span class="sid">{"usage.tokens"}</span></div></div>
<p class="anatomy">{"Компактная строка хода: модель, вход/выход и доля окна. Не дашборд «Расход» — только атом отображения в чате."}</p>
<div class="usage-line">
<span>{"deepseek/deepseek-flash"}</span>
<span>{"вход 18 240 · выход 2 110 · пример"}</span>
</div>
<div class="meter" style="margin-top:10px">
<div class="top"><span>{"Окно контекста"}</span><span>{"8%"}</span></div>
<div class="progress"><i style="width:8%"></i></div>
</div>
</>; }

const SPECIMENS = [
{ id: "color.palette", name: "Палитра", search: "палитра цвета токены color.palette фон панель акцент", group: "found", Content: Specimen0 },
{ id: "type.scale", name: "Типографика", search: "типографика шрифт заголовки type.scale", group: "found", Content: Specimen1 },
{ id: "space.scale", name: "Отступы", search: "отступы интервалы space.scale сетка", group: "found", Content: Specimen2 },
{ id: "radius.scale", name: "Скругления", search: "скругления радиус radius карточка капсула", group: "found", Content: Specimen3 },
{ id: "elevation", name: "Тени", search: "тени elevation глубина меню тост", group: "found", Content: Specimen4 },
{ id: "border", name: "Границы", search: "границы линии border разделитель", group: "found", Content: Specimen5 },
{ id: "icon.size", name: "Размер иконок", search: "иконки размер icon.size", group: "found", Content: Specimen6 },
{ id: "button", name: "Кнопки", search: "кнопки button.primary button.secondary button.ghost button.danger", group: "atoms", Content: Specimen7 },
{ id: "button.icon", name: "Икон-кнопки", search: "икон-кнопки квадратные button.icon плюс копировать", group: "atoms", Content: Specimen8 },
{ id: "control.segmented", name: "Сегменты", search: "сегменты control.segmented переключатель вида", group: "atoms", Content: Specimen9 },
{ id: "tab.pills", name: "Вкладки и пилюли", search: "вкладки пилюли tab.pills подвкладки", group: "atoms", Content: Specimen10 },
{ id: "input", name: "Поля ввода", search: "поля ввода input.text input.secret input.textarea input.number пароль текст число", group: "atoms", Content: Specimen11 },
{ id: "select", name: "Селекты", search: "селект select.searchable select.multi мультиселект поиск опции подзаголовок", group: "atoms", Content: Specimen12 },
{ id: "choice", name: "Флажки и радио", search: "чекбокс радио input.checkbox input.radio флажок", group: "atoms", Content: Specimen13 },
{ id: "control.toggle", name: "Переключатель", search: "переключатель тумблер control.toggle", group: "atoms", Content: Specimen14 },
{ id: "input.slider", name: "Слайдер", search: "слайдер ползунок input.slider", group: "atoms", Content: Specimen15 },
{ id: "input.group", name: "Группа полей", search: "группа полей input.group приставка команда", group: "atoms", Content: Specimen16 },
{ id: "input.search", name: "Поле поиска", search: "поиск input.search фильтр", group: "atoms", Content: Specimen17 },
{ id: "badge", name: "Бейджи, чипы и теги", search: "бейджи чипы теги badge chip tag", group: "atoms", Content: Specimen18 },
{ id: "tooltip", name: "Тултип", search: "тултип подсказка tooltip", group: "atoms", Content: Specimen19 },
{ id: "avatar", name: "Аватары", search: "аватар avatar инициалы группа 24 36 48 72", group: "atoms", Content: Specimen20 },
{ id: "status.dot", name: "Точка статуса", search: "точка статуса status.dot онлайн занят ошибка", group: "atoms", Content: Specimen21 },
{ id: "spinner", name: "Спиннер и скелетон", search: "спиннер скелетон загрузка spinner skeleton", group: "atoms", Content: Specimen22 },
{ id: "progress", name: "Прогресс и метр токенов", search: "прогресс метр токенов progress meter.tokens бюджет", group: "atoms", Content: Specimen23 },
{ id: "kbd", name: "Клавиатурные подсказки", search: "клавиатура подсказки kbd хоткеи", group: "atoms", Content: Specimen24 },
{ id: "divider", name: "Разделители", search: "разделитель divider линия", group: "atoms", Content: Specimen25 },
{ id: "link", name: "Ссылки", search: "ссылки link переход", group: "atoms", Content: Specimen26 },
{ id: "nav.breadcrumb", name: "Хлебные крошки", search: "хлебные крошки nav.breadcrumb путь проект чат", group: "patterns", Content: Specimen27 },
{ id: "disclosure", name: "Аккордеон", search: "аккордеон disclosure раскрытие summary", group: "patterns", Content: Specimen28 },
{ id: "menu.dropdown", name: "Меню", search: "меню контекстное dropdown menu", group: "patterns", Content: Specimen29 },
{ id: "feedback", name: "Уведомления", search: "тост уведомления alert info warning error success toast", group: "patterns", Content: Specimen30 },
{ id: "state", name: "Пустое состояние и ошибка", search: "пустое состояние ошибка empty error state", group: "patterns", Content: Specimen31 },
{ id: "pagination", name: "Пагинация", search: "пагинация pagination страницы дальше назад", group: "patterns", Content: Specimen32 },
{ id: "table", name: "Таблица", search: "таблица table заголовок ячейка сотрудник", group: "patterns", Content: Specimen33 },
{ id: "file", name: "Вложение и загрузка", search: "файл вложение дропзона upload dropzone file.chip", group: "patterns", Content: Specimen34 },
{ id: "media.placeholder", name: "Плейсхолдеры медиа", search: "медиа плейсхолдер изображение видео соотношение сторон", group: "patterns", Content: Specimen35 },
{ id: "chat.row", name: "Строка чата", search: "строка чата chat.row список", group: "patterns", Content: Specimen36 },
{ id: "agent.tile", name: "Плитка агента", search: "плитка агента agent.tile", group: "patterns", Content: Specimen37 },
{ id: "plugin.tile", name: "Плитка плагина", search: "плитка плагина plugin.tile тумблер", group: "patterns", Content: Specimen38 },
{ id: "mcp.status", name: "Статус MCP", search: "mcp статус соединение запущен ошибка", group: "patterns", Content: Specimen39 },
{ id: "chat.bubble", name: "Пузыри чата", search: "пузыри чата chat.bubble пользователь агент система", group: "patterns", Content: Specimen40 },
{ id: "code.block", name: "Блок кода", search: "блок кода code.block копировать markdown", group: "patterns", Content: Specimen41 },
{ id: "tool.call", name: "Вызов инструмента", search: "вызов инструмента tool.call свёрнутый развёрнутый результат ошибка", group: "patterns", Content: Specimen42 },
{ id: "approval", name: "Одобрение", search: "одобрение approval разрешить запретить спросить", group: "patterns", Content: Specimen43 },
{ id: "composer", name: "Композер", search: "композер composer плюс микрофон отправить стоп капсула", group: "patterns", Content: Specimen44 },
{ id: "usage.tokens", name: "Расход токенов", search: "расход токенов usage.tokens кольцо бюджет", group: "patterns", Content: Specimen45 }
];

const GROUPS = [{ id: "found", name: "Основы", caption: "Семантические токены и базовые размеры." }, { id: "atoms", name: "Атомы", caption: "Настоящие контролы и подписанные состояния." }, { id: "patterns", name: "Составные элементы", caption: "Композиции атомов. Все действия демонстрационные." }];
export function KitPage() {
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const root = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const notify = (text: string): void => { setNotice(text); clearTimeout(timer.current); timer.current = setTimeout(() => setNotice(""), 2600); };
  const found = SPECIMENS.filter(s => (s.name + " " + s.id + " " + s.search).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const demoClick = (event: MouseEvent): void => {
    const el = event.target as HTMLElement;
    const chip = el.closest<HTMLElement>("[data-chip]");
    if (chip) { chip.classList.toggle("on"); return; }
    const button = el.closest<HTMLButtonElement>("button");
    if (!button || button.disabled || button.closest(".kit-toolbar, .kit-nav, .cselect")) return;
    if (button.dataset.toast) { notify(button.dataset.toast.replaceAll("мок", "демо")); return; }
    if (button.id === "kit-toast-btn") { notify("Демонстрационный тост. Ничего не сохранено."); return; }
    const page = button.closest(".pagination");
    if (page) { page.querySelectorAll("button").forEach(b => b.classList.toggle("on", b === button)); return; }
    if (!button.closest("summary")) notify("Демонстрация: рабочие данные не изменены.");
  };
  return <section class="kit-showcase" ref={root} onClick={demoClick} onInput={event => {
    const el = event.target as HTMLInputElement;
    if (el.id === "kit-demo-slider") { const out = root.current?.querySelector("#kit-slider-val"); if (out) out.textContent = (Number(el.value) / 100).toFixed(2); }
  }}>
    <div class="kit-toolbar"><label class="field"><span class="field-label">Поиск по набору</span><input type="search" placeholder="Компонент, состояние или токен" value={query} onInput={e => setQuery(e.currentTarget.value)} /></label>
      <span class="sid" role="status">{found.length} / {SPECIMENS.length} образцов</span>
      <button type="button" class="btn" onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; }}>Сменить тему</button>
    </div>
    <div class="kit-catalog-layout"><nav class="kit-nav" aria-label="Компоненты UI Kit">{GROUPS.map(g => <div class="nav-group" key={g.id}><div class="nav-label">{g.name}</div>{found.filter(s => s.group === g.id).map(s => <button type="button" class="nav-link" key={s.id} onClick={() => root.current?.querySelector(`[data-specimen="${s.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>{s.name}<span class="nid">{s.id}</span></button>)}</div>)}</nav>
      <div class="kit-content"><div class="intro"><h2>Дизайн-система харнеса</h2><p>46 подписанных образцов: основы, атомы и составные элементы. Селекты и переключатели — общие компоненты Sinty. Все цифры и операции ниже — локальные демонстрации, без записи в рабочие данные.</p></div>
        {!found.length && <div class="intro" role="status">Ничего не найдено. Попробуйте другое название или токен.</div>}
        {GROUPS.map(group => <div key={group.id}>{found.some(s => s.group === group.id) && <section class="layer"><h2>{group.name}</h2><p>{group.caption}</p></section>}{found.filter(s => s.group === group.id).map(({ id, Content }) => <article key={id} class="specimen" id={"kit-" + id} data-specimen={id}><Content /></article>)}</div>)}
      </div>
    </div>
    {notice && <div class="toast" role="status">{notice}</div>}
  </section>;
}
