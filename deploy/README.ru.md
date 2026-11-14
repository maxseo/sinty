# Sinty 0.5.1 — Docker / один общий staff-сервер

## Что подготовлено
`example.com` — зарезервированная landing-заглушка; `app.example.com` — весь текущий харнес и его существующий экран входа. Кнопка сайта и прямой адрес ведут в ОДНУ установку. Это не междоменный SSO и не второй баланс/аккаунты Syntet.ru. Auth остаётся штатным: `/v1/auth/login`, Bearer, localStorage текущего app-origin; родительские cookies не добавляются. Реальные домен/VPS ещё не выбраны, ничего не развёрнуто.

Это одна доверенная установка сотрудников, НЕ sandbox для взаимно недоверенных клиентов/плагинов. Без Docker socket, privileged и монтирования всей VPS. RBAC приложения не заменяет ОС-изоляцию; отдельные внешние клиенты требуют следующего архитектурного этапа.

## Предпосылки и сборка на Linux amd64
Нужен существующий Docker Engine + Compose v2 на VPS, свободные 80/443, DNS A (и AAAA только при работающем IPv6) обоих имён на VPS. Не запускайте несколько копий харнеса с одним SQLite home.

Из корня ТОЧНОГО локального release-коммита:
```
cp deploy/.env.example deploy/.env
# Вручную указать ROOT_DOMAIN, APP_DOMAIN; SOURCE_REVISION = git rev-parse HEAD.
# Значения example.com — только placeholders. .env не содержит секретов.
docker compose --env-file deploy/.env -f deploy/compose.yml config
docker compose --env-file deploy/.env -f deploy/compose.yml build --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" sinty
```
Сборка устанавливает Linux-зависимости по pnpm-lock и lockfile импортированного Diffusion compiler, `--ignore-scripts`; не переносит Windows node_modules/ShellBox.exe. Образ Node24 Debian; Linux ARM и Alpine/musl для харнеса не проверены. Базовые Node и Caddy закреплены tag+digest, проверенными через публичный registry; это не аудит их уязвимостей. Для production запишите также digest итогового image. Имя `sinty:0.5.1` не означает, что образ уже опубликован.

## Первый запуск — форма в браузере на адресе приложения

Это штатный путь, не плагин: те же `GET`/`POST /v1/auth/setup` и `Accounts.setup` в ядре. Контейнер сам инициализирует пустой home (`initHome`, без печати machine token) и начинает слушать, даже если сотрудников ещё нет. После того как DNS указывает на сервер и открыты только 80/443:

```
docker compose --env-file deploy/.env -f deploy/compose.yml up -d
docker compose --env-file deploy/.env -f deploy/compose.yml ps
```

Откройте `https://app.<домен>/` (штатный redirect `/ui/ui-web/`). Первый посетитель видит форму email+пароль и создаёт единственного суперадмина. После этого setup отвечает 409, показывается обычный вход, повторно форма не открывается (в том числе после перезапуска). Нет пароля по умолчанию. Другие неавторизованные API по-прежнему закрыты. Прямой 3180 наружу не публикуется. Секретный machine token CLI `web` не печатается Docker-entrypoint в логи.

Риск принят сознательно: первый, кто откроет адрес, пока setup ещё открыт, может занять место администратора. Отдельный одноразовый токен, IP-фильтр и пароль в терминале для этого пути не используются. `Accounts.setup` сериализуется транзакцией `BEGIN IMMEDIATE`, поэтому при гонке создаётся не больше одного суперадмина. Если в volume уже есть пользователи, форма не показывается и существующие учётки не повышаются.

Необязательная альтернатива для закрытой/офлайн инициализации (TTY, пароль не в argv/env) по-прежнему доступна до первого пользователя:

```
docker compose --env-file deploy/.env -f deploy/compose.yml run --rm --no-deps --entrypoint node sinty /opt/sinty/deploy/bootstrap.mjs
```

Она вызывает те же `initHome`/`Accounts.setup`, копирует bundled навыки без перезаписи конфликтов и не стартует плагины, агента или provider calls. После появления хотя бы одного пользователя и `bootstrap.mjs`, и браузерная форма отказываются создавать второго.

ВАЖНО: наличие локального Windows-аккаунта не переносит его БД на VPS автоматически. Distribution намеренно НЕ содержит accounts.db или ключей. Для сохранения именно прежнего логина нужен отдельно согласованный приватный перенос/миграция account-state; не кладите его в Git/образ/Release.

## Caddy и корневой домен

Образец `deploy/Caddyfile` обслуживает два имени из `.env`:

- `APP_DOMAIN` (обычно `app.<зона>`) — харнес, вход и first-run. Его Caddy должен публиковать.
- `ROOT_DOMAIN` — только заглушка «место для будущего сайта» со ссылкой на приложение, не сам staff-харнес и не отдельная регистрация.

Если корневой домен должен остаться свободным (другой сайт, другой процесс на 80/443), удалите блок `{$ROOT_DOMAIN}` из Caddyfile и не указывайте это имя в DNS на этот стек. Не публикуйте apex этим compose, если он вам не нужен. Cross-origin запросы к API/UI по-прежнему отвечают 403, если `Origin` не равен `https://{$APP_DOMAIN}`.

## Данные, плагины и инструменты
UID/GID1000; whole `SINTY_HOME=/var/lib/sinty` — persistent named volume `sinty_sinty_home`, включая config, encrypted secrets+key, accounts, roster, projects/workspace, plugin data, навыки и память. App code immutable `/opt/sinty`, rootfs read-only, `/tmp` tmpfs. Docker-managed том получает начального владельца из образа; для собственного bind mount заранее выставить UID1000, не включать root/privileged ради прав.

Все 37 зарегистрированных плагинов и 20 навыков включены как КОД, включая ранее отключённые. Четыре home-варианта приоритетны, исходные варианты сохранены отдельно, background-tasks вариант тоже. Фактическая enable/disable конфигурация локального пользователя НЕ копируется и НЕ изменяется. Новый home использует штатные defaults; прочие плагины включаются осознанно. Existing home остаётся authoritative.

FFmpeg, Chromium/browser, HyperFrames managed CLI/data, Python, ImageMagick и прочие внешние программы/модели НЕ включены и не запускаются сборкой. Поэтому включённый plugin/skill не означает готовность всех его runtime-возможностей. Для Hyperframes убран привязанный к разработчику Windows fallback; предусмотрены `SINTY_FFMPEG` / `SINTY_CHROMIUM` пути при отдельной настройке tools и их разрешений. Runtime tools требуют отдельного проверенного image/volume-конфига, не apt-install внутри immutable контейнера.

## Proxy/streaming и авторизация
Caddy сохраняет Host; стандартно формирует X-Forwarded-* без доверия произвольному внешнему forwarded user. Core не использует forwarded identity вместо bearer. SSE flush_interval -1, WebSocket upgrade — штатный reverse_proxy, без маленького stream timeout и без retry платного POST на proxy. Proxy body limit64MB — дополнительный предел, НЕ отменяет меньшие лимиты core. Browser Origin для API/plugin/UI должен точно совпадать с HTTPS app-origin; CLI без Origin всё равно требует Bearer. CORS на весь домен не открывается. Auth localStorage привязан к app-origin; hotlink с landing не передаёт токены в URL. Не включайте proxy access logs с query-token или телами запросов; HTTPS TLS ещё не проверен на настоящем домене.

## Обновление вручную и откат — механизм кнопки НЕ реализован
1. До остановки проверить активные turns/tasks в штатном UI/API; не обрывать paid turn. При active — дождаться/отложить.
2. Зафиксировать текущий image digest и сделать согласованный private backup ВСЕГО home (SQLite accounts/journal вместе с WAL и encryption key). Для гарантированно согласованного restore делать после graceful drain/stop или штатным SQLite backup, а не произвольный live `cp`.
3. `docker compose ... stop -t 90 sinty`; убедиться в завершении. Обновление только из проверенного release SHA/image digest. Затем `docker compose ... up -d --no-deps sinty`; проверить health/login/роster/skills и вручную переключить proxy при pilot.
4. Если новая schema-data несовместима, одного downgrade image недостаточно: восстановить парный pre-update snapshot в отдельный том после сохранения свежих данных. НЕ затирать текущие пользовательские изменения старым full-home автоматически.

На этом этапе не опубликованы GitHub Release/image, не настроено SSH, не развёрнут VPS, не реализована update-кнопка. Docker build/HTTPS/startup будут отдельно отмечены как выполненные только при реальной проверке. При создании новых sessions не отправлять paid prompts ради smoke-test.
