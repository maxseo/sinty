# tool-web

The web tools of Sinty: `web.search`, `web.read`, `web.links`, `web.screenshot`, `web.interact`. They were core tools
until plan step 7; names, descriptions and input schemas are unchanged, so policies (`policy.yaml tools`), approvals,
the supervisor and old journals keep working. The plugin is on by default; turn it off with
`plugins.disabled: [tool-web]` in config.yaml or by unticking it in Settings.

## Tools

- `web.search {query}`: titles, urls and snippets. DuckDuckGo HTML by default, or your own SearXNG (`searchEngine`).
- `web.read {url}`: the page as Markdown plus up to 40 links. Text is untrusted.
- `web.links {url}`: only the links of a page.
- `web.screenshot {url}`: PNG under `workspace/browser` (setting `screenshotDir`). Needs Playwright Chromium.
- `web.interact {url, actions}`: up to 8 actions (`click`, `type`, `press`, `goto`) in a headless browser, then
  Markdown, links and a screenshot. Selectors are CSS.

All five are `sideEffects: external`, so the default policy asks the human.

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
| `maxPageKb` | 1500 | larger pages fail |
| `maxChars` | 20000 | Markdown is cut after this |
| `maxLinks` | 40 | links per page |
| `userAgent` | `Sinty/1.0` | |
| `browserTimeoutSeconds` | 20 | page load in the browser |
| `actionTimeoutSeconds` | 8 | wait for a click target |
| `screenshotDir` | `browser` | folder inside the workspace |
| `allowPrivate` | empty | host[:port] list the core lets through |
