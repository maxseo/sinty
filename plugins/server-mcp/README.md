# server-mcp

An MCP server over Streamable HTTP at `http://127.0.0.1:3180/p/server-mcp/mcp`. It is stateless: plain JSON responses, no server-initiated streams. Clients authenticate with the Sinty API token as a bearer token.

| Tool | Does |
|---|---|
| `sinty_ask` | `message`, `session_id?`, `title?`: runs a turn and returns the answer, `session_id` and `status` |
| `sinty_sessions` | recent sessions and whether they are running, blocked or idle |
| `sinty_session_messages` | user and agent messages of a session |

Cursor (`.cursor/mcp.json`):

```json
{ "mcpServers": { "sinty": { "url": "http://127.0.0.1:3180/p/server-mcp/mcp", "headers": { "Authorization": "Bearer snt_..." } } } }
```

Claude Code:

```sh
claude mcp add --transport http sinty http://127.0.0.1:3180/p/server-mcp/mcp --header "Authorization: Bearer snt_..."
```

The agent's own approvals still apply. If a turn waits for one, `sinty_ask` returns, and the answer says so. Approve in the Web UI, then call `sinty_ask` again with the same `session_id`.

Enable it in `config.yaml`: add `server-mcp` to `plugins.enabled`.
