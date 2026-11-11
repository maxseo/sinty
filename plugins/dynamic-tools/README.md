# Dynamic tools / Динамичные инструменты

Optional bundled provider-wrapper plugin. No core, SDK, journal schema, model route, or production adapter is changed. Start it **before the source provider plugins** in `plugins.enabled`. Open its own sidebar page **Динамичные инструменты** (`#/t/dynamic-tools/settings`). Dynamic mode starts **OFF**; retention defaults to **chat**.

## Operation

- OFF forwards the incoming permitted `ProviderRequest` unchanged. No context marker or prompt modification is added in either mode. The loaded plugin still registers one `dynamic-tools.search` definition; OFF is not uninstallation or a promise of byte equality with a pre-install registry.
- ON advertises the real schemas of pinned tools, discovery, and activated tools. Original order, validation, execution permissions and adapter options remain intact. Defaults pin `fs.list`, `fs.read`, `skill.read` only when present in the incoming catalog; pins grant no rights.
- `dynamic-tools.search` accepts a name or English/Russian description and returns bounded short metadata. It **does not execute a tool**. Matches become their true schemas on the next ordinary model request; there is no generic call dispatcher.
- Chat retention keeps name activations until reset/new chat. Request retention consumes pending names once for the next logical request; the same context ticket keeps a stable subset across fallback, including host shortening of old tool-result bodies. Replay of a successful search never reactivates it. An already-consumed in-flight request is not recreated after a process crash; restart keeps pending names and the replay ledger, not provider continuation.
- Settings/pins apply to future logical requests; current streams are not aborted. A pin edit does not reshuffle an existing fallback ticket. A missing/invalid identity or a child allowlist without discovery **bypasses filtering with that request's permitted full catalog**, never a global catalog.
- Incoming `req.tools` is authoritative. Session catalogs and pending results are intersected again after permission/plugin changes. Search identity comes from host tool context and an internal random ticket correlated to a uniquely observed prompt fingerprint; model arguments never choose the chat. No marker is injected at all, so unsupported protocols are untouched too. Identical/concurrent ambiguous fingerprints or later context edits conservatively bypass filtering and invalidate stale search views instead of guessing identity. Tool-result bodies alone are excluded from the fingerprint to allow the host’s fallback trimming; roles, call IDs and other messages remain bound. Only names and replay keys persist; no prompts, schemas, tool arguments, credentials or provider responses are saved.
- Dynamic mode refuses tool outputs outside the actually advertised subset (or duplicate call IDs), preserves supplied usage and ends locally without executing a call or adding retries/fallback. Abort/transport errors otherwise propagate normally.

## Settings and measurements

The sandboxed iframe reuses Sinty's shared CSelect/Tog and light/dark tokens. The approved `dynamic-tools.catalog` bridge capability is exclusive to this plugin/tab, validates iframe source + opaque origin + per-instance nonce, accepts no URL/method/scope, GETs only `/v1/agent` and `/v1/plugins` through the parent's normal authenticated client, and forwards **only name, description, owner group**. No token/cookie, schemas, provider/config data or history crosses this bridge. This global metadata picker is not a runtime permission list. Descriptions render as escaped text.

Counters show full/pinned/activated/sent schema counts and UTF-8 bytes of the SDK tools JSON (including discovery). They are **not tokenizer counts, dollars, total-context savings, HTTP payload sizes, or measured quality improvements**. Core Context Inspector still sees the full pre-wrapper catalog. Refresh the page counters after your own normal request; this plugin never buys a test generation. Discovery can add a paid model step, miss a match, worsen cache hits or multi-tool planning; short tasks may cost more and chat activations accumulate.

The **own mode toggle** is the supported quick full-catalog switch. Standard plugin lifecycle OFF stops its process and can interrupt an active stream; ON appends after original providers, so the wrapper may no longer be selected. The UI warns when no request has been observed; restore first priority via the ordinary plugin order/restart when idle. We do not change lifecycle ordering. The sidebar surface avoids adding a hardcoded core Settings pane.

Supported delegation: shipped `openai-compat`, `anthropic`, `openai-responses` adapters, imported as bundled siblings. RunningHub's provider-wide `toolCallNameMode: catalog-compatible` remains untouched. Other protocols are untouched. Discovery must be visible to an agent's existing plugin/child permissions; otherwise filtering is safely bypassed.

Bounds: 2,048 chats; 2,048 live identity tickets (30-minute expiry); 4,096 outstanding search correlations; 4,096 successful replay keys per chat; up to 12 search hits; last 200 aggregate measurements in memory. Capacity is not handled by evicting pending calls: identity capacity bypasses filtering, discovery capacity ends locally with an explicit error; reset activation from the UI to clear persistent name/replay state. No automatic retry/resume or provider call is initiated.

## Offline verification

`pnpm --filter @sinty/plugin-dynamic-tools build`
`pnpm --filter @sinty/plugin-dynamic-tools test`
`node --test plugins/dynamic-tools/tests/host.test.mjs`
`node --test apps/web/tests/dynamic-tools.test.mjs`

Provider tests use mocked fetch or a localhost SSE fixture only. They never invoke filesystem/image tools or a real provider. UI tests run in isolated browser fixtures; production credentials are not used.
