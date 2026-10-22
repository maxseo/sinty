# Web tools move out of the core into `tool-web`; SSRF guard becomes a core service

- Date: 2026-10-21
- Area: packages/core (netguard, host, runner, protocol, config, coretools, agent), packages/sdk, schemas, plugins/tool-web, registry
- Plan step: 7, part 1 ([plan](../plan.md) section 4, from the original plan's section 10: "Web — вынести в плагин tool-web")
- Commits: `feat(tool-web): move web tools into a plugin, SSRF guard as a core service`
- PR: [#8](https://github.com/maxseo/sinty/pull/8) (merge `06dd3da`)

## What and why

`web.search`, `web.read`, `web.links`, `web.screenshot` and `web.interact` were core tools (`packages/core/src/web.ts`).
That had two costs:

- The DuckDuckGo result parser breaks whenever DuckDuckGo changes its HTML, and the agent could not repair it: the
  core is protected.
- `playwright` was a dependency of `@sinty/core`.

The plan keeps the SSRF protection in the core as a service, so the plugin needs no raw `net: ["*"]`. This change:

- moves the five tools into `plugins/tool-web`;
- adds `ctx.net.public` (fetch, check, browser proxy) backed by the new `packages/core/src/netguard.ts`;
- fills the gaps of the old checks:
  - CGNAT and mapped IPv6 were not refused;
  - DNS was checked but not pinned, so rebinding was possible;
  - the browser itself was not gated, so a public page could load `http://127.0.0.1/...` sub-resources.

## Files touched

- **Core guard:** `packages/core/src/netguard.ts` (new).
  - `resolvePublic()` checks a host and returns the address to use.
  - `publicFetch()` does manual redirects, a pinned `lookup`, a remote-address check, decoding and limits.
  - `checkPublicUrl()` checks a URL without fetching it.
  - `parseAllowPrivate()` reads the allowlist.
  - `startGuardProxy()` is a loopback HTTP/CONNECT proxy with a Basic credential.
- **Address table:** `packages/sdk/src/netaddr.ts` (new), with `classifyAddress`, `isPrivateAddress`, `parseIPv4`,
  `parseIPv6` and `isLocalHostname`. It is pure and has no I/O. The core uses it for every decision; plugins may use
  it to hide obviously private links.
- **SDK:** `packages/sdk/src/plugin.ts`
  - `PluginPermissions.browser`;
  - `PublicNet`, `PublicFetchInit`, `PublicProxy`;
  - `PluginContext.net.public`.
- **IPC:**
  - `packages/core/src/host/protocol.ts`: `net.public` (op `fetch` | `check` | `proxy`) and `net.result`.
  - `packages/core/src/host/runner.ts`: `ctx.net.public`. It builds a `Response` and sets `url` to the final address.
  - `packages/core/src/host/host.ts`:
    - `onNetPublic()` checks `"$PUBLIC"` / `browser`;
    - `guardOptions()` reads `allowPrivate` from `config.yaml` only;
    - there is one proxy per process, closed on exit;
    - `permissions.browser` → `--allow-child-process`, read on `browsersPath()`, `$DATA/tmp` as TMP/TEMP/TMPDIR, and
      the Linux files Playwright probes;
    - `web.*` names are reserved for `tool-web`.
- **Manifest:** `packages/core/src/host/manifest.ts` and `schemas/plugin-manifest.schema.json` add
  `permissions.browser` and describe `"$PUBLIC"`.
- **Core tools:**
  - `packages/core/src/coretools.ts`: the five web tools are gone from `CORE_TOOLS`. New `RESERVED_TOOL_PREFIXES` /
    `reservedToolOwner()`.
  - `packages/core/src/agent.ts`: the web branch of `runCoreTool` and the `./web.js` import are gone.
  - `packages/core/src/web.ts` and its test are deleted.
  - `packages/core/package.json`: `playwright` removed.
- **Migration:**
  - `packages/core/src/config.ts`:
    - `plugins.disabled`;
    - `DEFAULT_ON_PLUGINS = ["tool-web"]` and `withDefaultPlugins()`, applied in `loadConfig()` and the `Sinty`
      constructor;
    - `saveSettings()` keeps `plugins.disabled` in step with the ticked list.
  - `packages/core/src/api/server.ts` copies `plugins.disabled` after a save.
- **Plugin:** `plugins/tool-web/`
  - `src/index.ts`: the tools, with descriptions and zod inputs copied verbatim.
  - `src/page.ts`: `htmlToMarkdown`, unchanged.
  - `src/search.ts`: the DuckDuckGo and SearXNG parsers.
  - `src/settings.ts` and `src/browser.ts`.
  - Tests and `README.md`.
  - The manifest has the **Веб** settings section.
  - `rewriteRelativeImportExtensions` lets `.ts` imports run from `src` (patched copies) and from `dist`.
- **Registry and docs:** `registry/plugins.json` (regenerated); `docs/spec/net-public.md` (new); `plugin-manifest.md`;
  `architecture.md`; `plugins/README.md`; `CHANGELOG.md`.
- **Tests:**
  - `packages/core/src/__tests__/netguard.test.ts` and `tool-web.test.ts`;
  - fixtures `net-public`, `net-nopublic` and `web-squatter`.

## Design decisions

- **Same tool names and schemas.** `tool-web.test.ts` rebuilds the old zod inputs from main 646031f. It checks that
  the plugin's JSON Schema equals what `coreToolSchema()` produced and that the descriptions are identical. The
  golden prompts (`golden/*.json`) pass unchanged.
- **Policy and approvals.** All five tools keep `sideEffects: "external"`, so the default policy still asks. The
  `web_failed` error code and its hint "Only public http(s) pages. Private hosts are blocked." are kept.
- **Default-on bundled plugin rather than a config rewrite.**
  - `withDefaultPlugins()` appends `tool-web` to `plugins.enabled` in memory unless `plugins.disabled` lists it.
  - `config.yaml` is never touched by loading, so existing configs, Max's included, keep web tools after the update.
  - Unticking it in Settings writes `plugins.disabled: [tool-web]`; ticking it again removes that key.
- **Ownership.** `web.*` is reserved for `tool-web`, so no other plugin can register `web.read` and get its calls.
  Before the move the core reserved those names; this keeps that guarantee.
- **The core decides, the plugin asks.**
  - `ctx.net.public` runs the request in the core process.
  - The plugin never resolves or connects by itself: its plain `fetch` is still limited to `permissions.net` ∩
    `net.allow`, and `"$PUBLIC"` never matches a host.
- **Checks.**
  - All DNS records are checked; one private record refuses the host.
  - The connection uses a pinned `lookup` returning the checked address, and `remoteAddress` is verified on connect.
  - The same happens on every redirect hop.
  - TLS keeps SNI and certificate checks on the host name.
- **Browser gating through a core proxy, not request interception.**
  - Playwright `page.route` only sees what Chromium chooses to report, and it runs in the plugin. A proxy sees every
    TCP connection, runs in the core, and needs no trust in the plugin.
  - Playwright forces `<-loopback>` into Chromium's bypass list, so loopback goes through the proxy too. The test
    `the browser goes through the core proxy` proves this: an `<img>` and a `fetch()` to 127.0.0.1, localhost and
    `[::1]` never reach the server.
  - WebRTC non-proxied UDP and QUIC are off.
- **Allowlist.**
  - `allowPrivate` lives in `plugins.config.tool-web` and is edited in the plugin's Settings section, as asked.
  - The core reads it straight from `config.yaml` on every request, never from manifest defaults or the IPC message,
    so a patched plugin cannot widen it. This is the same rule as `$CONFIG.<key>` grants.
- **198.18.0.0/15 is not refused.** On the box every public name resolves into that range: a fake-ip DNS, as used
  by Clash and sing-box TUN proxies that are common in Russia. Refusing it would turn the web off for those users,
  and the old core allowed it too.
- **Self-repair.**
  - `plugins/tool-web` is `editable: true`. `supervisedTools()` now marks the web tools as patchable.
  - The parser is isolated in `src/search.ts` with a fixture in `src/search.test.ts`.
  - The patch pipeline runs those tests from source; the type-stripping imports use `.ts` specifiers. A
    parser-breaking patch therefore ends as `failed_tests`, which a test covers.
  - A patched copy has no `node_modules`, so `browser.ts` falls back to the install's `playwright`, resolved next to
    `@sinty/sdk`.
- **Settings section «Веб»:**
  - search engine (`duckduckgo` or `searxng` + `searxngUrl`) and `maxResults`;
  - `timeoutSeconds`, `maxPageKb`, `maxChars`, `maxLinks`, `userAgent`;
  - `browserTimeoutSeconds`, `actionTimeoutSeconds`, `screenshotDir` (kept inside the workspace);
  - `allowPrivate`.

  Defaults equal the old core constants (8 results, 20 s, 1.5 MB, 20 000 chars, 40 links, 8 s click, `workspace/browser`).

## Rejected alternatives

- **Auto-adding `tool-web` to `config.yaml`.** That rewrites the human's file on start, and a human who removed the
  line on purpose would get it back.
- **A separate non-editable browser plugin.** It would keep `--allow-child-process` out of the editable plugin, but
  the task asked for one plugin `tool-web`. See Known limitations.
- **Blocking with `page.route` only.** It lives in the plugin and misses requests Chromium makes outside the page,
  such as WebSockets and workers.
- **An undici dispatcher for pinning.** undici is not a direct dependency. `node:http`/`https` with `lookup` does the
  same and keeps TLS host checks.

## Migration notes

- An existing `config.yaml` (for example `plugins.enabled: [context-inspector, kanban, provider-anthropic,
  provider-openai-compat, tool-fs, ui-web]`) gets `tool-web` at start without any edit. The web tools work as before.
- Policies keyed on `web.*` (`policy.yaml tools`, per-agent rules) and incidents stored for `web.interact` keep
  matching.
- The first `web.screenshot`/`web.interact` after the update still needs Playwright Chromium in the per-user cache.
  `npx playwright install chromium` is unchanged. The plugin reads the browsers from `PLAYWRIGHT_BROWSERS_PATH` or
  the default cache.
- `install.ps1` / `stage.mjs` need no change: the plugin's `playwright` dependency is installed with the stage.

## Known limitations

- **Child processes.** `permissions.browser` implies `--allow-child-process`, which the Node permission model cannot
  narrow. A patched `tool-web` could start other programs. Mitigations:
  - patches are applied only by a human;
  - permission changes are flagged;
  - the network rules still live in the core.

  Splitting the browser into a non-editable helper is the follow-up if that is not enough.
- **No in-process network sandbox.** Node 24 has no network permission, so the guard limits what the plugin's own
  code can do through the SDK, `fetch` and the proxy. Raw `net.connect` from plugin code is not blocked; that was
  true for every plugin before this change.
- **Allowlist scope.** The allowlist matches names and addresses; a listed name may resolve anywhere.
- **Windows.** On Windows 11 (Max's PC, Node 24, Chromium 1248 in `%LOCALAPPDATA%\ms-playwright`) Playwright
  needed nothing beyond the browser folder and `$DATA/tmp`. The browser-behind-proxy test ran there, not skipped.
  A live run of `web.read`, `web.search` and `web.screenshot` against example.com and DuckDuckGo worked, and a
  `web.read` of `127.0.0.1:3180` was refused.

## How to test

- `pnpm -r --workspace-concurrency=1 run build && pnpm -r run test`.
- Core tests:
  - `netguard.test.ts`:
    - address classes;
    - URL spellings (`2130706433`, `0x7f.1`, `[::ffff:127.0.0.1]`, `localhost`, `*.local`, `file:`);
    - DNS to 127.0.0.1 and mixed answers;
    - redirects to metadata, loopback, IPv6-mapped, names and `file:`;
    - pinning (a name that exists only in the stub resolver loads, with one lookup);
    - gzip and size limit;
    - the proxy (407 without credential; 403 for loopback, metadata, `[::1]`, mapped IPv6, localhost and 10/8;
      live allowlist).
  - `tool-web.test.ts`:
    - on by default with identical schemas;
    - private URLs fail with `web_failed`;
    - `plugins.disabled` and the Settings round trip;
    - `web.*` squatting refused;
    - the `ctx.net.public` permission, block and allowlist;
    - the browser behind the proxy (skipped without Chromium);
    - a parser patch gated by its tests.
- Plugin tests: `plugins/tool-web` `page`, `search` and `settings` tests, from `dist` and from `src` (`node --test src/*.test.ts`).
- Results on 2026-10-21, Linux box and Windows (temp worktree, corepack pnpm, `SINTY_INSTALL_ROOT` cleared):
  - core 122 passed on Linux (2 Windows-only skipped) and 124 on Windows;
  - tool-web 7, supervisor 11, context-inspector 10, providers 3 + 4 + 3;
  - 0 failures.
