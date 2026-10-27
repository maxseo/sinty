import { useState } from "preact/hooks";
import { IconCheck, IconChevron, IconClose, IconDots, IconPlus, IconSearch, kitIcons } from "./icons";

const lightColors: [string, string][] = [
  ["--bg", "#f4f4f5"],
  ["--panel", "#ffffff"],
  ["--panel-2", "#fafafa"],
  ["--text", "#050505"],
  ["--muted", "#71717a"],
  ["--line", "rgba(0, 0, 0, 0.1)"],
  ["--line-strong", "#d4d4d8"],
  ["--accent", "#74ff2a"],
  ["--accent-hover", "#72e035"],
  ["--accent-3d", "#58cd1a"],
  ["--accent-soft", "rgba(116, 255, 42, 0.22)"],
  ["--accent-text", "#000000"],
  ["--user", "#ecfccb"],
  ["--warn", "#fff6dc"],
  ["--warn-line", "#e0b84a"],
  ["--err", "#fff0f0"],
  ["--err-line", "#f87171"],
  ["--ok", "#58cd1a"],
  ["--btn", "#74ff2a"],
  ["--btn-text", "#000000"],
  ["--field", "#ffffff"],
  ["--menu", "#ffffff"],
  ["--hover", "#f4f4f5"],
];
const darkColors: [string, string][] = [
  ["--bg", "#050505"],
  ["--panel", "#0a0a0a"],
  ["--panel-2", "#141414"],
  ["--text", "#ffffff"],
  ["--muted", "#a1a1aa"],
  ["--line", "rgba(255, 255, 255, 0.1)"],
  ["--line-strong", "#2a2a2a"],
  ["--accent", "#74ff2a"],
  ["--accent-hover", "#72e035"],
  ["--accent-3d", "#58cd1a"],
  ["--accent-soft", "rgba(116, 255, 42, 0.12)"],
  ["--accent-text", "#000000"],
  ["--user", "rgba(116, 255, 42, 0.12)"],
  ["--warn", "#2a2414"],
  ["--warn-line", "#e0b84a"],
  ["--err", "#2a1414"],
  ["--err-line", "#f87171"],
  ["--ok", "#74ff2a"],
  ["--btn", "#74ff2a"],
  ["--btn-text", "#000000"],
  ["--field", "#141414"],
  ["--menu", "#141414"],
  ["--hover", "#1c1c1c"],
];

function MenuDemo() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("Недавно изменённые");
  const items = ["Недавно изменённые", "Недавно созданные", "По алфавиту"];
  return (
    <div class="menu-wrap">
      <button class="secondary" onClick={() => setOpen(!open)}>{value} <IconChevron /></button>
      {open && (
        <div class="menu" role="menu">
          <div class="menu-label">Порядок</div>
          {items.map((item) => (
            <button key={item} class="menu-item" role="menuitem" onClick={() => { setValue(item); setOpen(false); }}>
              <span>{item}</span>
              {value === item && <IconCheck />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function OversightDemo() {
  const [section, setSection] = useState("Все");
  const [sort, setSort] = useState("Новые");
  const [menu, setMenu] = useState(false);
  const [category, setCategory] = useState("Все категории");
  const sections = ["Главная", "Все", "Недавние"];
  const sorts = ["Новые", "Избранное", "А–Я"];
  const groups: { label: string; items: [string, number][] }[] = [
    { label: "", items: [["Все категории", 192]] },
    { label: "Тема", items: [["Технологии", 108], ["Софт", 68], ["Мобильные", 32]] },
    { label: "Портфолио", items: [["Агентства", 54], ["Дизайн", 40]] },
  ];
  return (
    <div class="ov">
      <aside>
        {sections.map((name) => (
          <button key={name} type="button" class={section === name ? "on" : ""} onClick={() => setSection(name)}>
            <span>{name}</span>
            <span class="count">{name === "Главная" ? "" : name === "Все" ? "192" : "18"}</span>
          </button>
        ))}
      </aside>
      <div class="ov-main">
        <div class="ov-bar">
          <div class="seg">
            {sorts.map((name) => (
              <button key={name} type="button" class={sort === name ? "on" : ""} onClick={() => setSort(name)}>{name}</button>
            ))}
          </div>
          <div class="menu-wrap">
            <button type="button" class="ov-ghost" onClick={() => setMenu(!menu)}>{category} <IconChevron /></button>
            {menu && (
              <div class="ov-menu">
                {groups.map((group) => (
                  <div key={group.label || "all"}>
                    {group.label && <div class="ov-label">{group.label}</div>}
                    {group.items.map(([name, n]) => (
                      <button key={name} type="button" class={category === name ? "on" : ""} onClick={() => { setCategory(name); setMenu(false); }}>
                        <span>{name}</span><span>{n}{category === name ? "  ✓" : ""}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
          <span class="grow" />
          <button type="button" class="ov-line">Войти</button>
          <button type="button" class="ov-black">Смотреть</button>
        </div>
        <p class="small muted">Выбрано: {section}. Порядок: {sort}. Категория: {category}.</p>
      </div>
    </div>
  );
}

export function KitPage() {
  const [open, setOpen] = useState(false);
  return (
    <section class="page kit">
      <h2>UI Kit</h2>
      <h3>Как на Oversight</h3>
      <p class="small muted">Светлая панель, выбранный пункт серой плашкой, чёрная и белая кнопки, переключатель на серой дорожке, меню группами. Близкие готовые наборы в этом духе: shadcn/ui и Radix Themes. Здесь образец на наших стилях, без чужой библиотеки.</p>
      <OversightDemo />
      <p class="muted">Текст 16px. Кнопки, поля и списки одной высоты. Скругление одно.</p>
      <h3>Кнопки</h3>
      <p class="small muted">Большая</p>
      <div class="row">
        <button class="lg"><IconPlus /> Новый проект</button>
        <button class="lg secondary">Инструкция</button>
        <button class="lg" disabled>Недоступна</button>
      </div>
      <p class="small muted">Средняя</p>
      <div class="row">
        <button><IconPlus /> Новый проект</button>
        <button class="secondary">Инструкция</button>
        <button class="accent">Обновить</button>
      </div>
      <p class="small muted">Маленькая</p>
      <div class="row">
        <button class="sm"><IconPlus /> Добавить</button>
        <button class="sm secondary"><IconDots /></button>
        <button class="sm ghost icon" aria-label="Закрыть"><IconClose /></button>
      </div>
      <h3>Поиск и меню</h3>
      <div class="row">
        <label class="search">
          <IconSearch />
          <input placeholder="Поиск проектов" />
        </label>
        <MenuDemo />
      </div>
      <h3>Плашки</h3>
      <div class="banner err"><span class="badge-dot" /> Ошибка. Не удалось сохранить.</div>
      <div class="banner info"><span class="badge-dot" /> Требуется обновление. <span class="grow" /><button class="sm accent">Обновить</button></div>
      <div class="banner soon"><span class="badge-dot" /> Скоро. Этот раздел ещё не включён.</div>
      <h3>Подсказка</h3>
      <p>Навык <span class="tip" tabIndex={0}>i<span class="tip-bubble">Навык — текстовая инструкция. Агент читает её и делает шаги сам.</span></span></p>
      <h3>Поля</h3>
      <div class="fields">
        <label class="field">Текст<input placeholder="Пустое поле" /></label>
        <label class="switch"><input type="checkbox" checked /><span /> Включено</label>
        <label class="switch"><input type="checkbox" /><span /> Выключено</label>
        <label class="switch"><input type="checkbox" disabled /><span /> Недоступно</label>
        <label class="radio"><input type="radio" name="kit" checked /><span /> Выбрано</label>
        <label class="radio"><input type="radio" name="kit" /><span /> Не выбрано</label>
      </div>
      <h3>Иконки</h3>
      <p class="muted small">Файл <code>apps/web/src/icons.tsx</code>. На экране 20×20, линия 2, скруглённые концы. Имя под плиткой — то, по которому иконка ищется в коде.</p>
      <div class="icon-grid">
        {kitIcons.map(({ name, label, Icon }) => (
          <div class="icon-cell" key={name}>
            <span class="icon-tile"><Icon /></span>
            <span>{label}</span>
            <code>{name}</code>
          </div>
        ))}
      </div>
      <h3>Цвета</h3>
      <p class="muted small">Имена из <code>apps/web/src/style.css</code>. Светлая тема — <code>:root</code>, тёмная — <code>[data-theme="dark"]</code>.</p>
      <div class="swatch-cols">
        <div>
          <h4>Светлая</h4>
          <div class="swatch-grid">
            {lightColors.map(([name, value]) => (
              <div class="swatch" key={name}>
                <span class="swatch-chip" style={{ background: value }} />
                <code>{name}</code>
                <span class="muted small">{value}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h4>Тёмная</h4>
          <div class="swatch-grid">
            {darkColors.map(([name, value]) => (
              <div class="swatch" key={name}>
                <span class="swatch-chip" style={{ background: value }} />
                <code>{name}</code>
                <span class="muted small">{value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <h3>Окно</h3>
      <button onClick={() => setOpen(true)}>Открыть диалог</button>
      {open && (
        <div class="overlay" onClick={() => setOpen(false)}>
          <form class="dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); setOpen(false); }}>
            <header class="dialog-head">
              <h3>Новый проект</h3>
              <button type="button" class="sm ghost icon" aria-label="Закрыть" onClick={() => setOpen(false)}><IconClose /></button>
            </header>
            <label class="field">Название<input placeholder="Название проекта" /></label>
            <label class="switch"><input type="checkbox" /><span /> Общая папка</label>
            <footer class="dialog-actions">
              <button type="button" class="secondary" onClick={() => setOpen(false)}>Отмена</button>
              <button type="submit">Создать</button>
            </footer>
          </form>
        </div>
      )}
    </section>
  );
}
