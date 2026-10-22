# Docs

Index of the documentation, and the handoff notes for whoever (a person or a coding agent) continues the project from
the repository alone.

| Document | What it is |
|---|---|
| [architecture.md](architecture.md) | principles, core components, extension points, process model |
| [spec/](spec/) | contracts: [protocol](spec/protocol.md) (events, API, prompt caching), [journal](spec/journal.md), [plugin manifest](spec/plugin-manifest.md), [policy](spec/policy.md), [supervisor](spec/supervisor.md), [memory](spec/memory.md), [context snapshots](spec/context-inspect.md), [public network](spec/net-public.md) |
| [plan.md](plan.md) | the memory / minimal-core plan of October 2026: decisions, status of every step with PR numbers |
| [roadmap.md](roadmap.md) | milestones, work done after 1.0, known gaps |
| [backlog.md](backlog.md) | open items, each with why and what it changes for the agent |
| [journal/](journal/README.md) | why each change was made; index by date and PR |
| [integrations.md](integrations.md), [migration-from-n8n.md](migration-from-n8n.md) | how Sinty connects to other systems and replaces n8n |

## Как подхватить проект

### Что прочитать сначала

1. [`AGENTS.md`](../AGENTS.md) в корне — правила для кодовых агентов (границы ядра, код, проверки). Этот файл
   задаёт правила; здесь они не повторяются, а дополняются практикой.
2. [architecture.md](architecture.md) — из чего состоит система.
3. [plan.md](plan.md) — почему память и инструменты устроены именно так и что из плана сделано.
4. [roadmap.md](roadmap.md) (раздел «Done after 1.0» и «Known gaps») и [backlog.md](backlog.md) — что сделано и что
   открыто.
5. [journal/README.md](journal/README.md) — индекс журнала. Перед правкой области прочитайте её записи, от старых к
   новым; в разделах «Known limitations» — честный список того, что не доделано.
6. Спецификации той области, которую меняете: [spec/memory.md](spec/memory.md), раздел «Prompt caching» в
   [spec/protocol.md](spec/protocol.md#prompt-caching), [spec/supervisor.md](spec/supervisor.md),
   [spec/policy.md](spec/policy.md).
7. `CHANGELOG.md` — что видно пользователю, раздел `[Unreleased]`.

### Рабочие правила

- **Сначала плагин.** Новая возможность — плагин в `plugins/<name>/` с `sinty.plugin.json`. Ядро меняется, только
  когда без этого никак (безопасность, журнал, контракт), и это объясняется в журнале.
- **Память подключаемая.** Хранилища и обработчики памяти — плагины через `ctx.memory.provider/processor`; модели —
  через `ctx.models` (ключи и учёт в ядре). В ядре остаются маршрутизатор, `builtin:sqlite` (sqlite-vec не грузится
  под `--permission`), бюджет, порядок блоков, маскировка секретов и пометка недоверенного. См. [plan.md](plan.md).
- **Инварианты кэша промпта.** Каждый запрос к модели только дописывает к предыдущему:
  - никаких часов и другого меняющегося текста в системном промпте; время хода — в `turn_context`;
  - `turn_context` и снимок памяти записываются в журнал и воспроизводятся тем же текстом;
  - инструменты отсортированы детерминированно; system-секции плагинов (`ctx.systemSection`) возвращают тот же текст
    для того же входа;
  - context-плагины только дописывают в хвост;
  - обрезка старых результатов и сжатие — ступенчатые, а не на каждом ходу;
  - провайдеры не склеивают поздние system-сообщения в начало запроса.

  Подробно — [spec/protocol.md → Prompt caching](spec/protocol.md#prompt-caching); тест —
  `packages/core/src/__tests__/prompt-cache.test.ts`. Изменение раскладки промпта меняет «золотые» снимки
  (`packages/core/src/__tests__/golden/`) — только намеренно и с объяснением в журнале.
- **Супервизор остаётся в ядре.** Детекторы, эскалация и конвейер патчей не выносятся в редактируемые агентом
  плагины.
- **Одна ветка и один PR на изменение**, от свежего `main`.
- **Без слияния без Макса.** PR сливает или явно разрешает слить только Max.
- **Журнал и CHANGELOG в каждом изменении.** Новая запись в `docs/journal/` по формату из
  [journal/README.md](journal/README.md) (и строка в индексе), строка в `CHANGELOG.md` → `[Unreleased]`.
- **Тест, который падает на старом коде.** Исправление или новая возможность приходит с тестом, который не проходит
  на предыдущем `main`; в журнале — как это проверено.
- **Полный прогон в двух часовых поясах.** `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test`, затем
  `TZ=UTC pnpm test`, затем `pnpm typecheck`. CI на GitHub должен быть зелёным. Изменения, которые касаются Windows
  (shell, пути, процессы), проверяются и на Windows.
- **Никогда не печатать токены и секреты** — ни токен входа, ни ключи провайдеров, ни строки логов, где они могут
  оказаться. Секреты в конфиге — только ссылки `secret://`.

### Состояние на 2026-10-22

`main` = `68fb472` (PR #18). Все PR #1–#18 слиты; открытых PR по коду нет. Полный набор тестов проходит на Linux
(231 pass, 0 fail, 2 skipped; также при `TZ=UTC`) и на Windows (Node 24.12.0, 228 pass, 5 skipped). Что делать
дальше — [backlog.md](backlog.md); веха M7 (переезд с n8n) — последняя в [roadmap.md](roadmap.md).
