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

The only way the agent changes code. Core tool:

```ts
plugin.propose_patch({
  plugin: "syntet",
  reason: "generate_image sends width as string; API requires integer",
  changes: [{ path: "src/tools/generate-image.ts", patch: "<unified diff>" }]
})
```

Steps, each journaled as `plugin.patch.*`:

1. **Branch.** `$SINTY_HOME/plugins` is a git repo; the patch goes to `agent/<plugin>/<ulid>`.
2. **Guard.** Reject if the plugin has `editable: false`, if paths leave the plugin folder, or if the core or schemas are touched.
3. **Permission diff.** If `permissions` in the manifest change, require human approval regardless of policy.
4. **Test.** Build and run `tests` in a sandbox with the plugin's own permissions. Failure → `plugin.patch.tested { ok: false, output }` back to the agent.
5. **Approve.** Policy `plugin.patch`: `auto` (tests pass), `ask` (default) or `deny`.
6. **Apply.** Start the new version side by side, healthcheck, switch traffic, stop the old process.
7. **Canary.** Watch the next N calls (default 5). Errors above the previous rate → automatic rollback to the previous commit and `plugin.patch.rolled_back`.

New plugins go through the same pipeline (`plugin.propose_patch` with a new name) and always require approval for their first permissions.
