# Web errors keep their meaning; site refusals stop counting as tool misuse

- Date: 2026-10-21
- Area: plugins/tool-web, packages/supervisor, packages/core (netguard, host runner/protocol, journal, sinty, config, settings-sections), packages/sdk
- Plan step: follow-up to step 7 part 1 (`2026-10-21-tool-web-plugin.md`) and to the supervisor settings (`2026-10-20-supervisor-settings-ui.md`); found on installed main f3b5533
- Commits: `f53f0db fix(tool-web, supervisor): web errors keep their codes, site refusals never stop the turn`
- PR: [#10](https://github.com/maxseo/sinty/pull/10) (merge `150f018`)

## What and why

A user turn ("check PS5 Pro prices on Yandex Market and others") was stopped with «Супервизор остановил работу
(tool_error): supervisor notices did not help (tool_error: 3, total 3)». The sequence was:

1. `web.read` on market.yandex.ru: `web_failed: response is larger than 1500000 bytes`.
2. `web.search` and `web.interact` succeeded (Yandex answered a 403 captcha page that `web.interact` reported as a
   normal result).
3. `web.read` on dns-shop.ru: `web_failed: page returned 401`.
4. `web.read` on lite-store.ru: `web_failed: page returned 404`. The turn stopped here.

Five separate defects added up:

- **One code for everything.** `fail()` in `plugins/tool-web/src/index.ts` turned every error (the core's
  `too_large`, `timeout`, `net_failed`, a site's 401/404, a Playwright selector timeout) into `web_failed` with the
  fixed hint "Only public http(s) pages. Private hosts are blocked." The hint was wrong for every one of these errors,
  and the code hid whether the call was wrong or the site refused.
- **Site refusals counted as tool misuse.** `Supervisor.checkpoint()` counts notices per detector per turn and
  escalates past `maxNoticesPerDetector` (2). The three failures were three `tool_error` notices, so the third stopped
  the turn. Successful calls in between do not reset that count. Changing a setting would not have helped either:
  it only moves the limit. Level 2 ("failure #2 … do not repeat the same call") counted tool+code only, so three
  different shops read as "repeating".
- **The README in every notice.** `failureNotice()` added the first `docsMaxChars` (1500) characters of the plugin
  README to every failure, again in each notice. The tool-web README is ~2,800 characters of mostly general text, all
  five tools share it, and the model already had it from the first notice.
- **Junk incidents.** In `onEvent()` any successful call of the same tool after any failure became that tool's "fix"
  (`st.fixes.set(call.tool, call.args)`). An incident was stored per tool+code, and later failures quoted the last two
  incidents with the same tool+code. All web errors were `web_failed`, so a 429 on one site "was fixed" by reading
  privetpeople.ru, and that url was then offered as the fix for a 401 on dns-shop.ru.
- **The page size limit failed instead of cutting.** `maxPageKb` (1500) went to `ctx.net.public.fetch` as `maxBytes`.
  `readBody()` in `netguard.ts` rejects with `too_large` once the decoded HTML passes it, before any conversion. Yet
  `htmlToMarkdown` keeps only `maxChars` (20,000) characters anyway, and a shop page's HTML is mostly scripts.
  Also, the default user agent `Sinty/1.0` is the kind of agent anti-bot services (Qrator on dns-shop) answer 401/403
  to.

## Files touched

- `packages/core/src/netguard.ts`: `PublicRequest.truncate`, `PublicResponse.truncated`; `readBody()` can return the
  first `maxBytes` instead of failing, and checks the 4 × `maxBytes` raw limit only on compressed bodies.
- `packages/core/src/host/protocol.ts`, `packages/core/src/host/runner.ts`, `packages/sdk/src/plugin.ts`: `truncate`
  over IPC, `PublicFetchResponse` (`Response & { truncated }`).
- `plugins/tool-web/src/errors.ts` (new): `toWebError()`, `httpError()`, `statusHint()`, `blockedReason()`,
  `blockedNote()`, `HINTS`.
- `plugins/tool-web/src/index.ts`: `fail()` uses `toWebError()`; `fetchText()` sends browser headers and
  `truncate: true` and throws `httpError()`; `readPage()` marks truncated pages; `web.interact` / `web.screenshot`
  return `status` and `blocked`; argument mistakes are `invalid_args`.
- `plugins/tool-web/src/browser.ts`: `withBrowser()` passes the main navigation's status (`Navigation`); url errors
  are `bad_request` / `net_blocked` ToolErrors.
- `plugins/tool-web/src/settings.ts`, `sinty.plugin.json`: `maxPageKb` 5000, `BROWSER_USER_AGENT` (old `Sinty/1.0`
  maps to it), `acceptLanguage`; Settings → Веб gets help texts and an Accept-Language field.
- `plugins/tool-web/README.md`: one `## web.<tool>` section per tool, error codes documented.
- `packages/supervisor/src/protocol.ts`: `EXTERNAL_ERROR_CODES`.
- `packages/supervisor/src/supervisor.ts`: failures carry `target`, `external`, `fixed`; `externalNotice()` (detector
  `external_error`); per-target repeats; docs once per tool per turn via `docsSection()`; fixes via `isCorrection()`;
  incident matching via `messageKey()` and a host check (`similarIncidents()`).
- `packages/core/src/config.ts`: `supervisor.docsMaxChars` default 500; `settings-sections.ts`: help texts for
  `docsMaxChars` and `maxNoticesPerDetector`.
- `packages/core/src/journal.ts`: table `migrations`, `once()`, `dropIncidents()`; `packages/core/src/sinty.ts`:
  one-time drop of `web.*` / `web_failed` incidents.
- Tests: `packages/supervisor/src/notices.test.ts` (new), `supervisor.test.ts`; `plugins/tool-web/src/errors.test.ts`
  (new), `settings.test.ts`; core `netguard.test.ts`, `tool-web.test.ts`, `supervisor-settings.test.ts`.
- Docs: `docs/spec/supervisor.md`, `docs/spec/net-public.md`, `CHANGELOG.md`.

## Design decisions

- **The code says who is at fault.** `http_4xx`, `http_5xx`, `too_large`, `timeout`, `net_failed` mean the site or
  the network refused. `net_blocked`, `bad_request`, `invalid_args` mean the call was wrong. `web_failed` is the rest
  (browser actions). The supervisor knows the external codes as a fixed set (`EXTERNAL_ERROR_CODES`) rather than a
  new flag on `ToolError`. That needs no protocol change, any plugin can opt in by using the codes, and old journals
  stay readable. The status is in the message (`page returned 401 Unauthorized (www.dns-shop.ru)`), not in a new
  field.
- **External errors never stop the turn.** The agent is not ignoring advice when sites refuse it; stopping the turn
  turned "shops block bots" into "the agent failed". `external_error` notices still go out up to
  `maxNoticesPerDetector` and then stop being sent, because the tool result already carries the hint
  (`ERROR code: … Hint: …`). They do not count toward `maxNoticesPerTurn`. The loop detector and the turn budget
  still bound a turn that keeps hammering sites. The detector has no setting of its own; `checks.toolErrors` covers
  both.
- **A repeat is the same target.** The target is the url's host, else the first of `path`, `file`, `filePath`,
  `command`, `query`, `name`, `id`. Two 403s from one host are a repeat (level 2, "do not call it again"); three shops
  are not.
- **A fix is a corrected call.** A failure is fixed by a later successful call of the same tool on the same target,
  or by any call when the failed one named no target (the `invalid_args` case: `{}` → `{text: "hi"}`). Matching uses
  tool + code + `messageKey()`: masked, one line, urls cut to their host, numbers of 4+ digits dropped, so `404` vs
  `401` stays distinct. An incident whose fix names a url on another host than the failing call is not quoted.
- **Docs: the section, once.** `docsSection()` takes the text under a heading that names the tool, up to the next
  heading of that level or above, so subsections stay. Without such a heading it falls back to the start of the file,
  as before. A tool's docs are sent once per turn (`TurnState.docsSent`), not reset by a human message: they are
  already in the history. The 500 default fits a tool section.
- **Truncate, do not fail, for text pages.** `truncate` is opt-in in the core, so a download keeps the hard limit.
  tool-web uses it for `web.read`, `web.links` and `web.search`. A truncated page says so twice: `truncated: true` and
  a trailing `…[truncated]` (not doubled when `maxChars` already cut it). The default goes to 5000 KB, the core's own
  default. 20,000 KB stays the maximum.
- **Browser-like requests.** A desktop Chrome UA plus `accept` and `accept-language` (default `ru-RU,…`). An old
  `Sinty/1.0` saved by earlier Settings pages counts as "unset", because otherwise the fix never reaches installs
  whose config.yaml already holds the old default. Header values are stripped of CR/LF.
- **Block pages are results, flagged.** `web.interact` / `web.screenshot` stay `ok` on a 403 or captcha page (the
  screenshot can still be useful), but return `status` and a `blocked` note: "probably not the content … do not
  repeat". `blockedReason()` uses the status (≥ 400), then captcha / anti-bot words in the title or the text, only on
  short pages (< 3000 characters), so an article about captchas is not flagged.
- **One-time cleanup.** The new `migrations` table records `2026-10-21-drop-web-failed-incidents`, so the drop runs
  once. A `web_failed` incident stored later by the new rule (a corrected browser action) survives restarts. The
  incident secret scrub from PR #7 still runs on every start (it is idempotent).

## Rejected alternatives

- Only raising `maxNoticesPerDetector`: the turn survives a bit longer, but notices keep saying "Private hosts are
  blocked", keep pasting the README and keep offering other sites' urls.
- An automatic browser fallback in `web.read` on 401/403/429: a 20 s headless launch hidden inside a "read", against
  sites that mostly block the browser too (Yandex served a captcha to `web.interact`). The hint asks the model to try
  `web.interact` once instead, which it can decide against.
- A new `external` field on `ToolError` / `tool.call.failed`: more plumbing across the SDK, host protocol and journal
  for the same effect as a code convention.
- Deleting all old incidents: non-web incidents (for example `invalid_args` fixes) are mostly sound; only web
  failures were systematically wrong because of the single code.

## Migration notes

- On the first start the core drops stored `web.*` incidents with code `web_failed` and logs how many.
- `web.read` on a private address now fails with `net_blocked` (was `web_failed`); the hint is the same. Policies do
  not match error codes, so nothing else changes.
- Installs whose `config.yaml` has `plugins.config.tool-web.maxPageKb: 1500` keep that value, but big pages are now cut
  instead of failing. `supervisor.docsMaxChars` saved as 1500 by the Settings page also stays until changed.

## Known limitations

- `blockedReason()` is word-based (Russian and English). A captcha page with other wording and status 200 is not
  flagged.
- With `truncate`, a compressed body that passes 4 × `maxBytes` before its decoded size does returns what the decoder
  produced so far; that path is not covered by a test (it needs a body that compresses worse than 4:1 while arriving
  faster than it decodes).
- The user agent does not get past real anti-bot challenges (JavaScript checks, IP reputation). Yandex's "too many
  requests from your IP" is a limit on the user's address that no setting changes.
- Target detection is a fixed list of argument names. A tool whose target is under another key counts every call as
  untargeted (old behaviour for repeats; any later call may be its fix).

## How to test

`corepack pnpm -r test` (also with `TZ=UTC`). The regressions:
- `packages/supervisor/src/notices.test.ts`. On main all five scenario tests fail:
  - "the PS5 turn" (too_large, 401, 404, 503 on different shops: no escalation, `external_error` notices without
    docs, incidents or "Private hosts", no incident stored);
  - per-target repeats;
  - a docs section once per turn;
  - corrected-call incidents and strict matching.
- `plugins/tool-web/src/errors.test.ts`: codes and hints, and block-page detection.
- Core `tool-web.test.ts`:
  - a 400 KB page with `maxPageKb: 100` is read and marked `[truncated]`;
  - 401/403/429/404/503 give `http_4xx` / `http_5xx` with fitting hints;
  - the server sees a Chrome UA and `accept-language`;
  - with Chromium installed, `web.interact` / `web.screenshot` report status 403 and `blocked`.
- Core `netguard.test.ts` "truncate keeps the first maxBytes" and `supervisor-settings.test.ts` "dropped once on
  start".
