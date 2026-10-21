# Context snapshots and plugin UI tabs

Status: implemented (first version). Code:
- `packages/core/src/inspect.ts`;
- `packages/sdk/src/inspect.ts`;
- `Agent.callModel` / `Agent.buildContext`;
- `MemoryRouter.contextMessages(…, trace)`;
- `PluginHost.inspectors()`;
- `apps/web/src/plugin-tab.tsx`;
- `plugins/context-inspector`.

This page defines two core features. Both are small, opt-in and usable by any plugin:

1. **`context.inspect`** — the core hands a *context snapshot* to inspector plugins on every model step. A snapshot is
   the exact message list sent to the provider, with each message labelled by where it came from.
2. **`ui.tabs`** — a plugin declares pages that the Web UI shows as tabs, in a sandboxed iframe with a postMessage
   bridge.

The `context-inspector` plugin is built on both. The core has no inspector UI of its own.

## Enabling (off by default)

A snapshot holds the whole prompt: the system prompt, the memory block with private facts, recalled records and the
dialogue. So three conditions must all hold before the core sends one:

1. The manifest asks for it: `"permissions": { "context": ["inspect"] }`. If an agent patch adds this, it counts as
   a permission change, which a human must approve.
2. The human lists the plugin in `config.yaml`:
   ```yaml
   plugins:
     enabled: [..., context-inspector]
     inspect: [context-inspector]   # default: empty
   ```
   `config.yaml` is core-owned, so plugins and the agent cannot write it.
3. The plugin registers `ctx.onContextSnapshot(handler)`.

When the second condition fails, the host logs a warning saying which part is missing. When the first fails, the host
logs a different warning, and the plugin gets nothing. `GET /v1/plugins` reports `inspector: true|false` for each
plugin.

## When snapshots are built

`Agent.callModel` asks `PluginHost.inspectors()` at the start of every model step.

- **The list is empty** (the default): the agent creates no trace and builds nothing; `inspectStats.built` stays
  unchanged. The extra cost per step is one loop over the running plugins.
- **The list is not empty**:
  1. The agent passes a `ContextTrace` through `buildContext`, and the memory router fills it.
  2. After the step id is assigned, and before the provider is called, the agent builds a snapshot and sends it to
     each inspector over IPC.
  3. Delivery is fire-and-forget. A failing snapshot is logged and never fails the turn.
  4. Model fallbacks within one step reuse the same snapshot, because the messages do not change.

## Snapshot (`ContextSnapshot`, version 1)

| Field | Meaning |
|---|---|
| `id`, `stepId` | the step id (same as `model.request.stepId` in the journal) |
| `sessionId`, `turnId`, `step` | `step` is the 1-based model step inside the turn |
| `at`, `agentId`, `route` | time, memory agent id (roster persona or `agent.name`), first route tried |
| `persona?` | where the first system text came from: `{ source: "agent", agentName }` (the roster agent's own AGENTS.md) or `{ source: "global", agentName? }` (`~/.sinty/AGENTS.md`; `agentName` is set when the speaking agent's AGENTS.md field is empty) |
| `messages` | **exactly** the `ChatMessage[]` given to the provider, after redaction; inline images are replaced by their size |
| `parts[]` | one per message: `index`, `kind`, `source`, `id?`, `role`, `tokens`, `untrusted?`, `cacheHint?` (the message closes a stable zone: `static`, `session`, `turn`), `blocks?` (ids of the blocks inside a turn context) |
| `tools[]` | tool schemas offered on this step: wire name and token estimate |
| `tokens` | `messages`, `tools`, `total`, and `byKind` (sum of `parts[].tokens` per kind) |
| `memory.facts[]` | facts rendered in the `memory.profile` block: id, text, tier, scope, source, createdAt |
| `memory.summary?` | conversation summary text, `coversUntil` seq, tokens |
| `memory.recall?` | automatic recall: queries, records (id, provider, text, untrusted), tokens, `cached` (true on later steps of a turn) |
| `memory.hooks[]` | processor hooks that ran: `onTurnStart` (queries), `afterRecall` (record ids before/after), `beforeContext` (block ids before/after); `ms`, `ok`, `changed` |
| `contexts[]` | plugin context contributors (`ctx.context`): `ms`, `ok`, `error?`, tokens before/after, added and removed messages (content cut at 4000 chars), `reordered?` (the contributor changed earlier messages; the core kept the input and only its appended messages) |
| `cache?` | prompt-cache view: `hints[]` (`index`, `hint`), `cacheable` (messages and estimated tokens up to the last hint, tools included) and `reused` (leading messages identical to the previous step of the session in this process, their tokens, `toolsSame`, `divergedAt?` when an earlier message changed). See "Prompt caching" in `protocol.md` |
| `window?` | the step model's context window: `tokens`, `source` (`config` = `memory.contextTokens`, `route` = `models.contextWindows`, `provider` = the provider's model list, `table` = `KNOWN_CONTEXT_WINDOWS`, `fallback` = 128000), `compactAt` (65%: the dialogue is folded from there) and `ratio?` (provider tokens per chars/4 estimate token in this chat, from the previous step). The tab draws it as a ring: fill = the step's real `usage.inputTokens` once known, else `tokens.total × ratio`; the tick marks `compactAt` |
| `redactions` | number of strings in which a secret was masked |

Kinds of parts:
- `system`: the system prompt from the core (`source: core`), or a plugin system section (`ctx.systemSection`,
  `source` = the plugin, `id` = `<plugin>/<section>`);
- `skills`: the skills catalog, a system section of the `skills` plugin (`source: skills`, `id: skills/catalog`;
  snapshots from before plan step 7 say `source: core`, `id: skills`);
- `memory`: `memory.profile` (the session's frozen snapshot);
- `summary`: `memory.summary`;
- `turn`: a turn context (`<turn_context>`: time, recall, memory updates, blocks from `beforeContext` processors);
  `blocks` lists what it contains (`memory.recalled`, `memory.updates`, a processor's block id);
- `recall`, `processor`: kept for older snapshots; recall and processor blocks now travel inside `turn` parts;
- `plugin`: a message that a context contributor added (`id` = `<plugin>/<context>`);
- `dialogue`: messages from the journal.

Tokens use the same estimate as compaction: JSON length / 4.

How messages are labelled:
- The core labels the messages it built (system, system sections such as the skills catalog, memory blocks, dialogue).
- A message that a contributor added is labelled with the last contributor that added it.
- Messages are compared as whole JSON values, so a contributor that edits a message shows up as one removal plus one
  addition.

On later steps of a turn, no memory hook runs again: the turn context is read back from the journal. Those steps
show `recall.cached: true` and an empty `hooks`.

The inspector also keeps the provider's real usage per step (`usage.recorded`: `inputTokens`, `cachedTokens`,
`cacheMissTokens`, `cacheWriteTokens`) next to the estimates; the **Контекст** view marks the cache boundary (the
last hinted message) and, when the prefix changed, the first differing message.

## Redaction

Every string in the snapshot passes through two filters:
1. `SecretStore.redact`: known secret values of 6 or more characters.
2. Patterns:
   - private key blocks;
   - `sk-`/`rk-`/`pk-` keys;
   - `snt_` API tokens;
   - GitHub tokens: `ghp_`… and `github_pat_`;
   - Slack tokens: `xox?-`;
   - AWS key ids: `AKIA`…;
   - Google keys: `AIza`…;
   - JWTs;
   - `Bearer` values.

Matches become `[redacted]`. The journal already masks known secret values when it stores events, so those are
usually masked before the prompt is built. The patterns catch secrets the human pasted into a chat. The provider still
receives those, because the inspector does not change the prompt.

This is best effort. Treat snapshots as private data.

## Plugin UI tabs (`ui.tabs`)

```json
"ui": { "tabs": [{ "id": "context", "title": "Контекст", "path": "/tab", "placement": "session" }] }
```

Each tab has these fields:
- `id`: `[a-z][a-z0-9-]{0,31}`, unique within the plugin;
- `title`: 1 to 40 characters;
- `path`: a route of the plugin relative to `/p/<plugin>`;
- `placement` (optional): `"sidebar"` (default) or `"session"`. Any other value fails manifest validation.

A plugin can declare at most 8 tabs. The path may not contain a query, `.` or `..` segments, or a full URL. `ui`
needs `static`, `tabs`, or both. `static` keeps its old meaning.

`GET /v1/plugins` lists `tabs: [{ id, title, src: "/p/<plugin><path>", placement }]` for running plugins;
`placement` is always filled in (`"sidebar"` when the manifest omits it). Where the Web UI shows a tab depends on it:

| `placement` | Where | Route | Session |
|---|---|---|---|
| `sidebar` | its own page in the left navigation | `#/t/<plugin>/<tab>` | none |
| `session` | a view toggle in the header of an open chat, after **Чат** and **Журнал**; the iframe fills the area between the header and the composer, so the user can keep writing | the chat's own `#/s/<id>` | the open chat's id, via the bridge |

A session tab is not in the left navigation and has no `#/t/…` route. When the user picks a plugin view, the UI
remembers it (`localStorage["sinty.chatView"] = "tab:<plugin>/<id>"`) and opens the same view in the next chat, so you
can walk through chats and look at each one's context. Picking **Чат** or **Журнал** clears it. **Журнал** itself is
not remembered, as before.

### Isolation

The UI loads `src` in `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" allow="">`:
- `allow-same-origin` is not set, so the page runs in an opaque origin (`origin === "null"`). It cannot read
  the UI's localStorage (where the API token is), its cookies or its DOM.
- The iframe cannot attach the token, so the tab route must be `public: true` and serve only static HTML, no data.
  The context inspector serves it with this CSP: `default-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`. The page has
  no network access at all.

A headless browser check confirmed this: from inside the tab, `localStorage` and `parent.document` throw
`SecurityError`, and `fetch("/v1/sessions")` is blocked.

### Bridge protocol `tab/1`

| Direction | Message |
|---|---|
| tab → UI | `{ sinty: "tab/1", op: "ready" }` |
| UI → tab | `{ sinty: "tab/1", op: "init", plugin, tab, theme: "light" \| "dark", sessionId? }`; `sessionId` is set for a `session` tab |
| UI → tab | `{ sinty: "tab/1", op: "session", sessionId? }`: the open chat changed (no `sessionId`: no chat open). Sent only after `init` |
| tab → UI | `{ sinty: "tab/1", id: <number>, op: "get", path: "/snapshots?session=…" }` |
| UI → tab | `{ sinty: "tab/1", id, ok: true, data }` or `{ sinty: "tab/1", id, ok: false, error: { code, message } }` |

The UI accepts messages only from that iframe's window (`event.source`) and only:
- `GET` requests;
- paths matching `^/[A-Za-z0-9_\-./%]*(\?[A-Za-z0-9_\-.%=&+~]*)?$`;
- paths with no `.`/`..` segments (checked before and after decoding), no `//` and no backslash.

It forwards the request to `/p/<that plugin><path>` with the bearer token and `credentials: "omit"`. The response
must be JSON and at most 16 MB. At most 8 requests can be in flight at once.

The tab can reach only its own plugin's routes, never `/v1`. A plugin's data routes stay non-public and need the
token.

The session id the bridge hands to a `session` tab is not a secret and grants nothing. The tab still reaches only its
own plugin's routes, and what those return is up to the plugin. `context-inspector` passes it as
`/snapshots?session=<id>`. Today the Web UI remounts the chat view on every chat switch, so the frame reloads and
gets a fresh `init`. `op: "session"` is there so a host that keeps the frame alive can switch it without a reload, and
tabs must handle both.

### What a tab can still do

The tab's script is the plugin's code. It can navigate its own frame: the sandbox has no `allow-top-navigation`,
`allow-popups` or `allow-forms`, but a frame can still navigate itself. It could therefore leak data it was given into
a URL. This is why `context-inspector` is `editable: false`: the agent cannot patch it. A third-party tab plugin gets
from the bridge only what its own routes return, so it holds no more data than its permissions already allowed.

## Compatibility

- These are additions only. `ctx.onContextSnapshot` is a new method, and `permissions.context` and `ui.tabs` are new
  optional fields. `ui.tabs[].placement` is optional, and a tab without it stays in the sidebar.
- `ui.static` became optional, but only when `tabs` is given.
- `plugins.inspect` is optional.
- Existing plugins, manifests and configs are unchanged.
- IPC: new `context.snapshot` message (core → plugin) and an optional `inspects` flag in `ready`.
