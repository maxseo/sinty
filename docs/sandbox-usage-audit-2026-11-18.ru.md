# Проверка ограничений по реальным сессиям Sinty

Дата: 18 ноября 2026. Источники: локальный `journal.db` (read-only), startup logs, текущие `policy.yaml`/безопасные поля `config.yaml`, API health и код репозитория. Секреты и содержимое посторонних задач в отчёт не включены.

## Краткий вывод

История подтверждает необходимость апгрейда, но не поддерживает идею просто «ослабить клетку». Основная боль — повторяющиеся разрешения и несогласованные границы разных подсистем:

1. Shell иногда должен обращаться к SDK/исполняемым файлам вне workspace; доступ выдаётся повторно для каждой команды.
2. Shell path scanner путает часть синтаксиса команды с файловыми путями и при этом не может быть настоящей границей безопасности.
3. Plugin runtime, `fs.*`, shell и браузер имеют разные разрешённые корни и способы работы с процессами/loopback.
4. Некоторые блокировки правильные: корень профиля, `.sinty`, секреты и host system files нельзя открывать широкой постоянной выдачей.
5. Отдельный обнаруженный риск: startup logs содержат UI bearer token внутри URL. Это не ограничение агента, а утечка секрета через логирование.

Поэтому план остаётся актуальным: короткоживущие scoped grants и единая execution environment дадут удобство без постоянного доступа к профилю пользователя.

## Объём и метод

- `journal.db`: 156 сессий, 84 224 события на момент чтения.
- Для классификации использованы tool failures, approval requests/decisions, supervisor notices и сообщения, где прямо упоминались sandbox/path/runtime ошибки. Данные читались в режиме SQLite `readOnly`; база не менялась.
- В папке `logs` находятся только короткие startup output/error файлы, а не полноценный runtime log. Значимые причины отказов хранятся в journal events.
- Live API smoke check: `GET /v1/health` → 200 (`sinty/1.0`); `GET /v1/settings` и policy endpoint без Bearer → 401. Настройки не запрашивались с токеном и не менялись.
- В current config server слушает `127.0.0.1:3180`; policy — `mode: standard`, `none/read: allow`, `write/external: ask`. Для shell нет отдельного постоянного allow rule, поэтому он идёт по `external: ask`. На Windows shell запускается через ShellBox.

## Измеренные повторы

### Подтверждения и пути

- Зафиксировано **623 approval request для `shell.run` в 32 сессиях**.
- **409** из них были запросами на временный доступ к каталогу вне workspace; 214 — обычное policy approval.
- Из 409 path-grant запросов журнал показывает: **401 вызов завершился**, 2 были отклонены, 3 завершились `invalid_args`, 1 был прерван, по 2 нет terminal event.
- Самые часто запрашиваемые каталоги: FFmpeg — **215** раз, ImageMagick — **44**, Python — **40**, source tree проекта — **30**.

Это подтверждает ценность TTL grant с узким resource scope. При этом текущий путь grant остаётся read-only и не должен автоматически превращаться в доступ на запись.

### Shell path guard и ограничения ввода

Всего найдено **67 отказов `shell.run` с `invalid_args`**:

- 50 — проверка внешнего пути / профиля / workspace границы;
- 15 — запрошенный `timeoutMs` выше максимума 120 000 ms;
- 1 — команда длиннее 4 000 символов;
- 1 — `cwd` вне текущего workspace.

В path failures есть как правильные отказы (родитель workspace, `$SINTY_HOME`, профиль пользователя, данные Sinty), так и признаки хрупкого разбора команды: неоднозначные/экранированные пути, относительный подъём по `..`, glob-выражения и отдельные попытки обратиться к `C:\Program Files`, где ошибка показывала усечённый путь `C:\Program`.

**Вывод:** исправлять нужно scanner и интерфейс выдачи mount, но нельзя считать разбор текста shell надёжной песочницей. Безопасность должна обеспечиваться фактическим filesystem namespace/ACL runner-а.

### Plugin runtime, браузер и loopback

В событиях обнаружены повторяющиеся реальные ошибки:

- Node permission model выдавал `Access to this API has been restricted` для `readPackageJSON`, а также для файлового чтения/записи — **11 событий в 4 чатах**.
- Chromium/renderer возвращал ошибки чтения executable, запуска CDP и DevTools — **12 событий в 6 чатах**. В истории также есть `CreateNamedPipe`/crashpad как целевые диагностические сигналы пользователя.
- Для `web.screenshot` локальные `file://`/private destinations блокировались, хотя браузерный render workflow создавал локальный HTML.
- `fs.read/list/edit` отдельно отказывали на файлах за workspace, включая часть Sinty plugin/data directories.

В некоторых задачах агент обходил это упаковкой зависимостей, собственным renderer script или переключением на другой plugin. Это помогало закончить работу, но добавляло патчи, длительные прогоны и сложную диагностику.

**Вывод:** это не одна проблема permission policy. Нужны согласованные mounts для plugin data/runtime, отдельный контролируемый process/preview broker и точная декларация прав Node plugin runtime. Нельзя выдавать plugin-у доступ ко всему `$SINTY_HOME` ради чтения одного файла.

### Сеть

Найдено **10 сетевых блокировок в 7 чатах** (`net_blocked`/`net_denied` и HTTP/private-host restrictions). Часть — штатная защита web plugin от `file://` и private hosts; часть — локальный loopback/DevTools workflow, который не совпадает с требованиями renderer-а.

**Вывод:** это аргумент за точечный preview/egress proxy с hostname/port scope и TTL, а не за глобальное `network: true`.

### Остальные ошибки

В журнале всего **514 `tool.call.failed`**. Самые частые коды включают `plugin_error` (106), `invalid_args` (86), `empty_vision` (56), `not_found` (44), `unknown_tool` (30). Не все они связаны с клеткой: часть — ошибки провайдера, контента или аргументов. Это важно для оценки эффекта: расширение sandbox исправит только подмножество проблем.

## Текущие реальные ограничения и их оценка

| Наблюдение | Оценка | Что менять |
|---|---|---|
| Повторный approval для известных tools (FFmpeg, Python, ImageMagick) | Настоящее UX-трение; каждый отдельный запуск просит путь снова | TTL grant: tool directory read-only, текущая сессия/задача, явный revoke и журнал |
| Блок `$SINTY_HOME` целиком | Правильная hard boundary, но plugin data/runtime нельзя открывать даже узко | Явные системные mounts по plugin/data/runtime, без secrets/config/journal |
| Ошибки `C:\Program` и shell path parsing | Ошибка UX/диагностики, не основание расширять доступ | Windows-aware parsing только для preview/approval; enforcement — через runner mounts |
| 120s timeout и 4k command limit | Намеренные resource/input limits, неудобны для долгих задач и больших scripts | Запускать project script/job с бюджетом и отменой вместо увеличения лимита в бесконечность |
| Node FS permission / Chromium executable / named pipes | Недостающие runtime capabilities для конкретных плагинов | Manifest scopes и isolated runtime/VM image; IPC только через broker |
| `file://`/loopback блокируется web tools | Хорошая защита от SSRF, мешает локальному preview | Отдельный short-lived preview proxy на конкретный порт/route |
| Bearer token записан в startup URL в логах | Отдельный секретный риск, не связанный с удобством sandbox | Ротация текущего токена; не писать fragment/token в stdout/stderr; проверка redaction |

## Что это меняет в плане

1. **Добавить security task по логам:** проверить, активен ли token из старого лога, ротировать его, если он ещё действителен, и исправить logger/CLI. Для личной машины с закрытым доступом к логам риск ниже; до шаринга логов и cloud/multi-user запуска redaction обязателен. Я token не использовал и не ротировал.
2. Следующий sandbox PR всё ещё — Windows ACL lifecycle, но обязательно тестировать packaged `ShellBox.exe` и завершение/отмену процесса.
3. Перед VM-контрактом зафиксировать профили системных mounts: `workspace`, выбранные tool/runtime directories, plugin-owned data. Secret/config/journal roots всегда исключены.
4. TTL grants разделить на `tool execution read`, `project source read`, `plugin data read`, `preview port`; не использовать один общий grant на папку пользователя.
5. Зафиксировать в UI эффективный backend: AppContainer, bwrap, VM или host execution. Особенно важно для `standard`, где платформа может влиять на реальную изоляцию.

Подробный порядок работ и сценарии success/failure/compatibility/rollback — в [плане апгрейда](sandbox-upgrade-plan.ru.md). Архитектурный разбор и сравнение harness-подходов — в [обзоре архитектуры](architecture-review-2026-11-18.ru.md).
