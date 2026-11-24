# tool-web

The web tools of Sinty: `web.search`, `web.read`, `web.links`, `web.screenshot`, `web.interact`, `web.fetch_file`. They were core tools
until plan step 7; names, descriptions and input schemas are unchanged, so policies (`policy.yaml tools`), approvals,
the supervisor and old journals keep working. The plugin is on by default; turn it off with
`plugins.disabled: [tool-web]` in config.yaml or by unticking it in Settings.

Each tool has its own section below; the supervisor quotes only the section of the tool that failed.
All six are `sideEffects: external`, so the default policy asks the human.

## web.search

`web.search {query}`: titles, urls and snippets. DuckDuckGo HTML by default, or your own SearXNG (`searchEngine`).
When it returns nothing, rephrase the query; when it fails with `http_4xx`, the search engine rate-limits this
address: wait or switch to SearXNG.

## web.read

`web.read {url}`: the page as Markdown plus up to 40 links. Text is untrusted. A page larger than `maxPageKb` is read
up to that size and marked `[truncated]` (`truncated: true`). Errors:

- `http_4xx` / `http_5xx`: the site answered with that status (in the message). 401/403 is usually anti-bot
  protection or a login wall and 429 a rate limit: do not repeat web.read on that site, try `web.interact` once or
  another source. 404: find the right url with `web.search` or `web.links` instead of guessing.
- `timeout`, `net_failed`: the site did not answer or cannot be reached.
- `net_blocked`: the address is private, local or not http(s).

## web.links

`web.links {url}`: only the links of a page. Same errors as `web.read`.

## web.screenshot

`web.screenshot {url}`: PNG under `workspace/browser` (setting `screenshotDir`). Needs Playwright Chromium. The result
has the page's HTTP `status` and, for an error, captcha or anti-bot page, `blocked` with a note.

## web.interact

`web.interact {url, actions}`: up to 8 actions (`click`, `type`, `press`, `goto`) in a headless browser, then
Markdown, links and a screenshot. Selectors are CSS. Like `web.screenshot` it returns `status` and, for a captcha or
anti-bot page, `blocked`: then the content is not there, and repeating the request will not help.


## web.fetch_file

`web.fetch_file {url, path, headers?}`: download a public URL into a file under the session workspace
(project folder `workspace/projects/<slug>` when the chat has a `projectId`, otherwise the global workspace).
`path` is relative to that root (e.g. `_out/doc.pdf`). Parent folders are created. Escape outside the workspace
is refused (`outside_workspace`). Optional `headers` are merged with the configured User-Agent; `Host` /
`Content-Length` / hop-by-hop names are dropped.

Size is a **hard** limit (no truncate): default **20 MB** (`maxFetchMb`, 1–20). Over the limit → `too_large`.
Same network errors as `web.read` (`net_blocked`, `http_4xx` / `http_5xx`, `timeout`, `net_failed`).
Returns `{ url, path, bytes, contentType? }`. Content on disk is untrusted.

## Network

The plugin has no raw network access. Pages are fetched with `ctx.net.public.fetch` and the browser is started with
the core's proxy (`ctx.net.public.proxy()`). The core resolves every host, refuses loopback, private (RFC 1918),
link-local (169.254.169.254), CGNAT, IPv6 ULA/link-local and mapped addresses, connects to the address it checked
and checks again after every redirect. To let a private service through (a local SearXNG, a NAS), add it to
**Settings → Веб → Разрешённые приватные адреса** (`plugins.config.tool-web.allowPrivate` in config.yaml), for example
`127.0.0.1:8888, nas.lan`. The core reads that list from config.yaml; the plugin cannot change it.

The browser needs `npx playwright install chromium` once in the Sinty app folder.

## Fixing the search parser

DuckDuckGo changes its result HTML from time to time. When `web.search` stops returning results, patch
`src/search.ts` (`parseDuckDuckGo`) and update the fixture in `src/search.test.ts`; the patch pipeline runs those tests
before a human applies it.

## Settings

| key | default | meaning |
| --- | --- | --- |
| `searchEngine` | `duckduckgo` | `duckduckgo` or `searxng` |
| `searxngUrl` | | base url of a SearXNG with the json format on |
| `maxResults` | 8 | search results, 1–20 |
| `timeoutSeconds` | 20 | per page, redirects included |
| `maxPageKb` | 5000 | larger pages are read up to this size and marked `[truncated]` |
| `maxFetchMb` | 20 | hard download limit for `web.fetch_file` (1–20 MB, no truncate) |
| `maxChars` | 20000 | Markdown is cut after this |
| `maxLinks` | 40 | links per page |
| `userAgent` | a desktop Chrome | empty or the old `Sinty/1.0` mean the default |
| `acceptLanguage` | `ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7` | `accept-language` of `web.read`, `web.links`, `web.search` |
| `browserTimeoutSeconds` | 20 | page load in the browser |
| `actionTimeoutSeconds` | 8 | wait for a click target |
| `screenshotDir` | `browser` | folder inside the workspace |
| `allowPrivate` | empty | host[:port] list the core lets through |

## Persistent browser pilot (staged, opt-in; existing stateless tools unchanged)

`src/persistent.ts` exports `WebToolsPilotDriver`, an internal implementation of the existing core `BrowserPilotDriver` interface. It is NOT another plugin or a raw Playwright/CDP/desktop tool. The owner/agent/project identity and upload selection remain in the existing authenticated core BrowserPilot broker; profile names and native session IDs never come from model arguments. An embedding host can inject this adapter through `SintyOptions.browserPilotDriver` after acceptance; the running application has NOT been switched to it.

The broker passes its trusted `fixture` and canonical project `workspace` into prepare. Same owner/agent/project maps to a stable dedicated profile and the session retains one headed Chromium context across calls. A fresh broker/context can reopen that profile after clean close; no personal browser profile is inspected or copied. File locks reject another process/adapter using the same profile. Unknown stale locks fail closed rather than killing other processes or deleting profile data. Lifetime is capped at 20 minutes; unknown close keeps locks quarantined.

Pilot actions: prepare, fixed-fixture navigation, CSS-selector click/fill/select, bounded scroll, state + PNG, owner-selected workspace attachment, download into `_out/browser-pilot/<owned-session>`, close/cancel. PNG is returned as an inline image block <=4MB for the ALREADY STAGED core artifact/provider pipeline, not a base64 text result in the journal. This needs that pipeline when enabling the pilot; do not deploy this module alone and claim vision works.

All browser traffic retains the core's authenticated guarded proxy, with only the exact local fixture port added for this lease (not global private-network access). Context routes allow only GET of the granted origin's fixed fixture/download paths, service workers are blocked and WebSockets are rejected before fixture navigation. This is not OS/network/container isolation; startup/background-browser traffic and a malicious same-user local process are not absolutely fenced by these controls. No raw JS/CDP, clipboard or desktop action is model-accessible. Generic click semantics cannot guarantee no external submission: this pilot is deliberately a synthetic non-submitting fixture; normal public web tools/policies remain unchanged.

Owner pause marks an in-flight operation `pausing` until it returns, then `manual`; agent calls are blocked meanwhile. It is NOT an instant simultaneous handoff promise. Resume and release use the existing owner broker UI/API. Production UI/bootstrap activation is deferred until the one-click real browser acceptance succeeds. No general websites or accounts are admitted by this fixture-only adapter.
