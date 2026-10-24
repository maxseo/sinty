# Bundled plugins

Each folder has a `sinty.plugin.json` ([schema](../schemas/plugin-manifest.schema.json)). Start from [`example-echo`](example-echo). Planned plugins that are not in the tree yet are in the [backlog](../docs/backlog.md).

| Plugin | Kind | Status |
|---|---|---|
| `provider-openai-compat` | provider | shipped (M1) |
| `provider-anthropic` | provider | shipped (M1) |
| `provider-openai-responses` | provider | shipped (M3); add to `plugins.enabled` |
| `tool-fs` | tool | shipped (M1) |
| `tool-web` | tool (web.search, web.read, web.links, web.screenshot, web.interact; on by default) | shipped (plan step 7) |
| `mcp-catalog` | ui (Settings → MCP: list/add MCP plugins via POST /v1/plugins/mcp; on by default) | shipped (MCP phase 2) |
| `skills` | tool, context (skills catalog in the prompt; skill.read, skill.files, skill.read_file, skill.write_file, skill.edit, skill.write; on by default) | shipped (plan step 7) |
| `kanban` | tool, server, event | shipped (M3) |
| `server-mcp` | server | shipped (M3); optional |
| `server-openai-api` | server | shipped (M3); optional |
| `server-agui` | server | shipped (M3); optional |
| `ui-web` | ui | shipped (M3); static bundle from `apps/web` |
| `channel-webhook` | server | shipped (M4); optional |
| `channel-telegram` | server | shipped (M4); optional |
| `channel-voice` | server | shipped (M4); optional |
| `server-a2a` | server | shipped (M4); optional |
| `delegate` | tool | shipped (M4); optional |
| `herdr` | event | shipped (M4); optional |
| `otel` | event | shipped (M4); optional |
| `syntet` | tool | shipped (M4); optional |
| `context-inspector` | ui | optional; needs `plugins.inspect`, see its README |
