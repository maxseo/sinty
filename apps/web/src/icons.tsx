/** Набор иконок. Холст 24, на экране 20×20, линия 2, скруглённые концы. Менять рисунок здесь. */
const stroke = {
  width: "20",
  height: "20",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2",
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
  "aria-hidden": "true" as const,
};

export const IconPanelLeft = () => (
  <svg {...stroke}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /></svg>
);
export const IconPanelRight = () => (
  <svg {...stroke}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" /></svg>
);
export const IconSearch = () => (
  <svg {...stroke}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
);
export const IconClose = () => (
  <svg {...stroke}><path d="M18 6 6 18M6 6l12 12" /></svg>
);
export const IconPlug = () => (
  <svg {...stroke}><path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" /></svg>
);
export const IconBrain = () => (
  <svg {...stroke}><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" /><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" /><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" /></svg>
);
export const IconPlus = () => (
  <svg {...stroke}><path d="M5 12h14M12 5v14" /></svg>
);
export const IconChevron = () => (
  <svg {...stroke}><path d="m6 9 6 6 6-6" /></svg>
);
export const IconCheck = () => (
  <svg {...stroke}><path d="M20 6 9 17l-5-5" /></svg>
);
export const IconFolder = () => (
  <svg {...stroke}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
);
export const IconDots = () => (
  <svg {...stroke}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></svg>
);
export const IconPin = () => (
  <svg {...stroke}><path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></svg>
);
export const IconTrash = () => (
  <svg {...stroke}><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" /></svg>
);
export const IconArchive = () => (
  <svg {...stroke}><rect width="20" height="5" x="2" y="3" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4" /></svg>
);
export const IconBack = () => (
  <svg {...stroke}><path d="m12 19-7-7 7-7M19 12H5" /></svg>
);
export const IconRefresh = () => (
  <svg {...stroke}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></svg>
);
export const IconWarn = () => (
  <svg {...stroke}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4M12 17h.01" /></svg>
);
export const IconInfo = () => (
  <svg {...stroke}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
);
export const IconPencil = () => (
  <svg {...stroke}><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></svg>
);
export const IconCopy = () => (
  <svg {...stroke}><rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2" /></svg>
);
export const IconDownload = () => (
  <svg {...stroke}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
);
export const IconUpload = () => (
  <svg {...stroke}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
);
export const IconSort = () => (
  <svg {...stroke}><path d="m21 16-4 4-4-4M17 20V4M3 8l4-4 4 4M7 4v16" /></svg>
);
export const IconPuzzle = () => (
  <svg {...stroke}><path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" /></svg>
);
export const IconLink = () => (
  <svg {...stroke}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
);
export const IconGear = () => (
  <svg {...stroke}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
);
export const IconMic = () => (
  <svg {...stroke}><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" /></svg>
);
export const IconClip = () => (
  <svg {...stroke}><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
);
export const IconHome = () => (
  <svg {...stroke}><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
);
export const IconSun = () => (
  <svg {...stroke}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>
);
export const IconMoon = () => (
  <svg {...stroke}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>
);
export const IconDoor = () => (
  <svg {...stroke}><path d="M13 4h3a2 2 0 0 1 2 2v14" /><path d="M2 20h3M13 20h9" /><path d="M10 12v.01" /><path d="M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.561z" /></svg>
);

export const kitIcons: { name: string; label: string; Icon: () => any }[] = [
  { name: "panel-left", label: "Скрыть левую панель", Icon: IconPanelLeft },
  { name: "panel-right", label: "Скрыть правую панель", Icon: IconPanelRight },
  { name: "search", label: "Поиск", Icon: IconSearch },
  { name: "close", label: "Закрыть", Icon: IconClose },
  { name: "plug", label: "Вилка", Icon: IconPlug },
  { name: "brain", label: "Мозг", Icon: IconBrain },
  { name: "plus", label: "Добавить", Icon: IconPlus },
  { name: "chevron", label: "Стрелка", Icon: IconChevron },
  { name: "check", label: "Галочка", Icon: IconCheck },
  { name: "folder", label: "Папка", Icon: IconFolder },
  { name: "dots", label: "Три точки", Icon: IconDots },
  { name: "pin", label: "Пин", Icon: IconPin },
  { name: "trash", label: "Корзина", Icon: IconTrash },
  { name: "archive", label: "Архив", Icon: IconArchive },
  { name: "back", label: "Назад", Icon: IconBack },
  { name: "refresh", label: "Обновить", Icon: IconRefresh },
  { name: "warn", label: "Внимание", Icon: IconWarn },
  { name: "info", label: "Инфо", Icon: IconInfo },
  { name: "pencil", label: "Карандаш", Icon: IconPencil },
  { name: "copy", label: "Копировать", Icon: IconCopy },
  { name: "download", label: "Скачать", Icon: IconDownload },
  { name: "upload", label: "Загрузить", Icon: IconUpload },
  { name: "sort", label: "Сортировка", Icon: IconSort },
  { name: "puzzle", label: "Пазл", Icon: IconPuzzle },
  { name: "link", label: "Цепь", Icon: IconLink },
  { name: "gear", label: "Шестерёнка", Icon: IconGear },
  { name: "mic", label: "Микрофон", Icon: IconMic },
  { name: "clip", label: "Скрепка", Icon: IconClip },
  { name: "home", label: "Домик", Icon: IconHome },
  { name: "sun", label: "Солнце", Icon: IconSun },
  { name: "moon", label: "Луна", Icon: IconMoon },
  { name: "door", label: "Открытая дверь", Icon: IconDoor },
];
