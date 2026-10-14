# Sinty

**ИИ-агент Syntet, который одинаково работает на ноутбуке и на любом VPS.**
Один процесс, один файл SQLite, всё остальное — плагины.

> Статус: **v0.2, ядро и супервизор работают.** Цикл хода, журнал с восстановлением после сбоя, политики, изолированные плагины, HTTP API с SSE, CLI, провайдеры для OpenAI-совместимых API и Anthropic, инструменты для файлов. Супервизор подсказывает агенту при ошибках и зовёт человека, если подсказки не помогли. Через конвейер патчей агент чинит свои плагины: тесты в песочнице, история в git, автооткат. Дальше веб-интерфейс. План — в [roadmap](docs/roadmap.md).

[English version](README.md)

---

## Идея

**Тонкое ядро.** В ядре только цикл хода, реестр инструментов с проверкой по JSON Schema, политики доступа, журнал событий и хост плагинов.

**Плагины и скилы.** Модели, файлы, shell, веб, память, сжатие контекста, каналы (веб, Telegram, голос), веб-интерфейс, канбан, расписание — плагины. Скилы — обычные файлы `SKILL.md`.

**Агент улучшает себя, но не ядро.** Плагины и скилы агент переписывает через конвейер патчей: тесты, горячая замена, автооткат. До ядра, политик и секретов у него нет пути ни через инструменты, ни на уровне ОС.

**Сбой не теряет контекст.** Каждый шаг пишется в журнал до и после выполнения. Если убить процесс посреди вызова инструмента, ход продолжится с того же шага. Сжатие контекста ничего не стирает: журнал — источник истины, промпт — его проекция.

**Супервизор смотрит за каждым шагом.** Системный процесс ловит ошибки, зацикливание, таймауты и перерасход бюджета. Агенту приходит сообщение: «обрати внимание, подумай, вот дока, предложи исправление». Если не помогло — вопрос человеку.

**Стандарты отрасли.** MCP, A2A, AG-UI, ACP, Agent Skills (`SKILL.md`), `AGENTS.md`, OpenAI-совместимый API, OpenTelemetry. Кто работал с Claude Code, Codex или Hermes, разберётся сразу.

**Любая модель.** Протоколы OpenAI-совместимый (xAI Grok, DeepSeek, Ollama, vLLM, OpenRouter), OpenAI Responses и Anthropic Messages, с резервными маршрутами.

**Любой интерфейс.** Ядро говорит по протоколу. Веб-интерфейс (чат, канбан, журнал, панель супервизора) — один из клиентов наравне с Telegram, Herdr, вашим приложением и Claude, ChatGPT или Grok через MCP.

## Запуск из исходников (работает уже сейчас)

```sh
git clone https://github.com/maxseo/sinty.git && cd sinty
corepack enable && pnpm install && pnpm build      # Node.js 24+
alias sinty="node $PWD/packages/cli/dist/bin.js"   # PowerShell: function sinty { node "$PWD\packages\cli\dist\bin.js" @args }

sinty init                          # один раз печатает токен API
sinty secret set deepseek           # или anthropic, openai, xai
# в ~/.sinty/config.yaml указать models.default, например deepseek/deepseek-chat
sinty doctor
sinty run "создай notes/todo.md с тремя идеями на выходные"
sinty serve                         # HTTP API на 127.0.0.1:3180
```

## Быстрый старт (целевая установка)

> Установка пакетом появится на этапе M5.

```sh
# компьютер (Windows, macOS, Linux), Node.js 24+
npx sinty init          # создаёт ~/.sinty: конфиг, политика, git-репозиторий плагинов
npx sinty web           # запускает агента и открывает http://127.0.0.1:3180

# VPS
curl -fsSL https://raw.githubusercontent.com/maxseo/sinty/main/install.sh | sh
sinty init --mode strict   # ядро и агент под разными пользователями ОС
sinty service install      # unit systemd с автоперезапуском

# Docker
docker run -d -p 3180:3180 -v sinty:/data ghcr.io/maxseo/sinty
```

Модели подключаются в **Settings → Models** или в `~/.sinty/config.yaml`:

```yaml
providers:
  xai:       { protocol: openai-compat, baseUrl: https://api.x.ai/v1, apiKey: secret://xai }
  anthropic: { protocol: anthropic,     apiKey: secret://anthropic }
  openai:    { protocol: openai-responses, apiKey: secret://openai }
  local:     { protocol: openai-compat, baseUrl: http://127.0.0.1:11434/v1 }

models:
  default:  anthropic/<model-id>
  fallback: [xai/<model-id>, openai/<model-id>]
  cheap:    local/<model-id>
```

Значения `secret://` хранятся в зашифрованном хранилище (`sinty secret set xai`) и в контекст модели не попадают.

## Как защищено ядро

1. **Разные места на диске.** Ядро ставится только на чтение. Агенту доступны на запись только `skills/` и `workspace/`.
2. **Плагины изолированы.** Каждый плагин — отдельный процесс под разрешениями Node.js (`--permission`, запись только в свою папку), сеть и секреты — по манифесту. В режиме `strict` ядро и агент работают от разных пользователей ОС.
3. **`plugins/` меняется только через конвейер патчей.** Встроенный инструмент `plugin.propose_patch`: git-ветка, тесты плагина в песочнице, горячая замена, проверка здоровья, автооткат.
4. **Агент не расширяет себе права.** `policy.yaml`, `config.yaml`, секреты и журнал принадлежат ядру. Патч, который меняет права плагина, всегда подтверждает человек.
5. **Проверка целостности.** Ядро сверяет хеши при старте. Обновляет его только человек: `sinty upgrade`.

## Супервизор

Отдельный процесс на шине событий. Ловит:

- ошибки инструментов и неверные аргументы;
- повтор одного и того же вызова;
- таймауты и зависшие шаги;
- перерасход шагов, токенов и денег;
- пустой или обрезанный ответ модели;
- деградацию провайдера.

Лестница эскалации: **подсказка → смена стратегии или модели → патч плагина → остановка и вопрос человеку.** Ход переходит в состояние `blocked`, на канбане появляется карточка «Нужно решение». Решённые инциденты запоминаются. Спецификация: [supervisor](docs/spec/supervisor.md).

## Интеграции

| С чем | Как |
|---|---|
| Grok, ChatGPT, Claude как модели | плагины провайдеров |
| Sinty внутри Claude Desktop или Claude Code, ChatGPT, Grok | плагин `server-mcp` |
| Claude Code, Codex, Grok CLI как субагенты | плагин `delegate` (ACP или CLI) |
| Другие агенты | плагин `server-a2a` |
| Любой клиент OpenAI SDK | плагин `server-openai-api` |
| Herdr | плагин `herdr`: состояние и команда возобновления |
| Telegram, голосовые ассистенты | плагины каналов |

## Документация

- [Архитектура](docs/architecture.md)
- Спецификации: [события и API](docs/spec/protocol.md) · [журнал и восстановление](docs/spec/journal.md) · [манифест плагина и конвейер патчей](docs/spec/plugin-manifest.md) · [политики](docs/spec/policy.md) · [супервизор](docs/spec/supervisor.md)
- [Интеграции](docs/integrations.md)
- [Переезд с n8n](docs/migration-from-n8n.md)
- [Дорожная карта](docs/roadmap.md)
- [Безопасность](SECURITY.md) · [Как участвовать](CONTRIBUTING.md) · [Правила для кодовых агентов](AGENTS.md)

## Лицензия

[MIT](LICENSE)
