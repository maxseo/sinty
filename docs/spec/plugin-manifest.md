# Plugin manifest and patch pipeline

Every plugin is a folder with `sinty.plugin.json`. Schema: [`schemas/plugin-manifest.schema.json`](../../schemas/plugin-manifest.schema.json). Types: [`packages/sdk/src/plugin.ts`](../../packages/sdk/src/plugin.ts).

## Manifest

```json
{
  "$schema": "https://raw.githubusercontent.com/maxseo/sinty/main/schemas/plugin-manifest.schema.json",
  "name": "syntet",
  "version": "0.1.0",
  "description": "Generations, CMS and billing tools for a Syntet site",
  "kinds": ["tool", "event"],
  "runtime": "node",
  "entry": "dist/index.js",
  "permissions": {
    "fs": { "read": ["./"], "write": ["$WORKSPACE"] },
    "net": ["syntet.ru", "*.syntet.ru"],
    "secrets": ["syntet.api_token"],
    "env": [],
    "shell": false
  },
  "tools": [
    {
      "name": "syntet.generate_image",
      "description": "Start an image generation on the Syntet site",
      "sideEffects": "external",
      "idempotent": false,
      "recoverable": true,
      "docs": "docs/generate_image.md",
      "defaultPolicy": "allow"
    }
  ],
  "config": { "baseUrl": { "type": "string", "default": "https://syntet.ru" } },
  "tests": "node --test",
  "editable": true
}
```

| Field | Meaning |
|---|---|
| `kinds` | extension points the plugin uses: `provider`, `tool`, `context`, `channel`, `server`, `schedule`, `event`, `ui`, `memory` (memory providers/processors, see `docs/spec/memory.md`) |
| `runtime` | `node` (SDK, own process), `mcp-stdio` (any MCP server, any language), `http` (remote MCP endpoint) |
| `entry` | required for a node plugin unless `kinds` is only `ui` (static files, no process) |
| `permissions` | the only rights the plugin process receives; enforced by the host |
| `permissions.agent` | `sessions.read` and/or `sessions.write`: the plugin may call the agent API over IPC |
| `permissions.models` | model routes the plugin may call through `ctx.models` (`default`, `cheap`, `embed`, a `models.routes` key, or `*`) |
| `permissions.context` | `["inspect"]`: receive a context snapshot of every model step through `ctx.onContextSnapshot`; also needs the plugin in config `plugins.inspect` (see `docs/spec/context-inspect.md`) |
| `ui.static` | folder of static files served at `/ui/<name>/`, **only** when `editable` is `false` |
| `ui.tabs` | up to 8 Web UI tabs `{ id, title, path, placement? }`; `placement` is `sidebar` (default: a page in the left navigation) or `session` (a view toggle in an open chat's header next to Чат/Журнал, told the chat's `sessionId`); `path` is a public GET route of the plugin shown in a sandboxed iframe; data only through the UI's `tab/1` postMessage bridge to the plugin's own routes (see `docs/spec/context-inspect.md`). `ui` needs `static`, `tabs` or both |
| `settings` | a section of the Web UI settings (Settings → under Основные / Модели / Плагины) for this plugin's `config`: `{ title, description?, fields[] }`. A field is `{ key, label, type: number \| boolean \| select \| text, help?, group?, min?, max?, step?, integer?, optional?, options?, unit? }`; `key` is a dot path inside the config. Defaults are the manifest `config`; saved values go to `config.yaml` `plugins.config.<name>` and reach `ctx.config` after `sinty web` restarts. The core's own **Супервизор** section uses the same format (`GET /v1/settings/sections`, `PUT /v1/settings/sections/:id`) |
| `tools[].sideEffects` | `none`, `read`, `write`, `external`; drives default policy and resume behaviour |
| `tools[].idempotent` | safe to repeat with the same arguments |
| `tools[].recoverable` | plugin implements `recover(idempotencyKey)` |
| `tools[].docs` | markdown the supervisor shows when this tool fails |
| `editable` | whether the agent may patch this plugin; `false` for security-critical plugins and for any UI the core serves |

Input schemas are declared in code (zod) and exported by the plugin at load time; the host converts them to JSON Schema and stores them in the registry.

## `$DATA`, HTTP routes and agent access

- `$DATA` expands to `$SINTY_HOME/data/<plugin>`. A grant that touches another plugin's data folder is rejected.
- `$CONFIG.<key>` (read grants only) expands to the absolute path the human set in `config.yaml`
  `plugins.config.<plugin>.<key>`; the manifest's own `config` defaults are ignored, and an unset or relative value
  drops the grant. Used by `memory-obsidian` for its vault.
- Tool names of core tools (`memory.write`, `ask_human`, …) are reserved: a plugin that registers one fails to start.
- `ctx.http({ method, path, public?, handler })` registers a route under `/p/<plugin>`. `:param` is one segment, a trailing `*` the rest. The core strips `Authorization`, `Cookie` and hop-by-hop headers, and removes `token` from the query, before the plugin sees the request. `public: true` skips the bearer check.
- `ctx.agent` is the same session API the HTTP clients use. Arguments are validated in the core (`plugin-bridge.ts`); write ops need `sessions.write`; idempotency keys are prefixed with the plugin name; the actor is `{ kind: "plugin" }`.
- `createSSE` / `runTurn` in `@sinty/sdk` are helpers for streaming servers (MCP, OpenAI API, AG-UI).

## MCP servers as plugins

```json
{
  "name": "github",
  "kinds": ["tool"],
  "runtime": "mcp-stdio",
  "command": ["npx", "-y", "@modelcontextprotocol/server-github"],
  "permissions": { "net": ["api.github.com"], "secrets": ["github.token"] }
}
```

Tools are imported from the server's `tools/list`. Missing `sideEffects` default to `external` and policy `ask`.

## Lifecycle

`discover → validate manifest → spawn with permissions → handshake (tools, hooks, schemas) → healthcheck → ready`. On crash: restart with exponential backoff; after 5 crashes in 10 minutes the plugin is disabled and the supervisor is notified.

## Patch pipeline

The only way the agent changes code. Four core tools:

| Tool | Default policy | Does |
|---|---|---|
| `plugin.list` | allow | installed plugins, location (`bundled` or `home`), `editable`, tools |
| `plugin.read` | allow | list a plugin's files, or read one |
| `plugin.propose_patch` | allow | write new full file contents to a staging copy and test it; nothing runs yet |
| `plugin.apply_patch` | ask | commit, hot-reload, watch, roll back if needed |

```ts
plugin.propose_patch({
  plugin: "syntet",
  reason: "generate_image sends width as string; API requires integer",
  files: [{ path: "src/index.ts", content: "<full new file>" }]
})
// → { patchId: "pat_…", status: "ready", permissionsChanged: false, testOutput: "…" }
```

Steps, each journaled as `plugin.patch.*`:

1. **Guard.** Reject if the plugin has `editable: false`, if a path is absolute, contains `..`, or touches `node_modules`, `dist` or `.git`. At most 20 files of 200 KB each.
2. **Stage.** Copy the plugin to `$SINTY_HOME/plugins/.staging/<patchId>/<plugin>` and write the files there. A plugin that ships with the install (`bundled`) is forked: if its entry is `dist/…` and `src/index.ts` exists, the copy runs from `src/index.ts` through Node's type stripping, so no build step is needed. Relative imports in patched code must use `.ts` extensions.
3. **Permission diff.** If `permissions` in the manifest change, `plugin.apply_patch` always asks a human, whatever the policy says.
4. **Test.** Load the staged copy in its own sandbox (same permissions as in production) and check it registers. Then run every `*.test.ts`, `*.test.js` and `*.test.mjs` file with the same permission flags, 60 s limit. A failure returns `patch_tests_failed` with the output to the agent, and the patch cannot be applied.
5. **Apply.** `$SINTY_HOME/plugins` is a git repository (created on first apply). A bundled plugin is first committed as a fork, then the patch is committed on top. The old process is stopped and the new version started from disk. If it does not start, the previous commit is restored at once.
6. **Canary.** The next 5 calls to the plugin are watched. Two failures with `plugin_error`, `plugin_crashed`, `timeout` or `plugin_unavailable` restore the previous commit (for a fork, the bundled version) and record `plugin.patch.rolled_back`.

Tool errors the plugin raises on purpose (`ToolError` with its own code) do not count against the canary.

Not yet: creating new plugins through the pipeline, a policy mode that applies patches automatically when tests pass.
