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
| `kinds` | extension points the plugin uses: `provider`, `tool`, `context`, `channel`, `server`, `schedule`, `event`, `ui` |
| `runtime` | `node` (SDK, own process), `mcp-stdio` (any MCP server, any language), `http` (remote MCP endpoint) |
| `permissions` | the only rights the plugin process receives; enforced by the host |
| `tools[].sideEffects` | `none`, `read`, `write`, `external`; drives default policy and resume behaviour |
| `tools[].idempotent` | safe to repeat with the same arguments |
| `tools[].recoverable` | plugin implements `recover(idempotencyKey)` |
| `tools[].docs` | markdown the supervisor shows when this tool fails |
| `editable` | whether the agent may patch this plugin; `false` for security-critical plugins |

Input schemas are declared in code (zod) and exported by the plugin at load time; the host converts them to JSON Schema and stores them in the registry.

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
