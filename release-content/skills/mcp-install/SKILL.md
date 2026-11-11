---
name: mcp-install
description: Install an external MCP server when the user asks (mcp.install + ask), and auto-bind it to this agent.
---

# Install MCP on request

Use this when the human asks to add / install / connect an **MCP server** (GitHub, Postgres, Playwright, Slack, a custom npx package, an HTTP MCP URL, etc.).

## Do

1. Confirm the server shape briefly if unclear: **stdio** (`command` like `npx -y @…`) or **http** (`url`).
2. Call **`mcp.install`** with:
   - `name` — lowercase plugin id (`github`, `postgres-local`, …)
   - `runtime` — `mcp-stdio` or `http`
   - `command` **or** `url`
   - secrets only as **`secret://name`** in `env` / `permissions.secrets` (never paste raw tokens)
   - leave **`bind` unset** (defaults to `agent`) so the new MCP is enabled for **this** speaking agent
3. Wait for human **approval** (policy ask). After approve, tools from that MCP appear for this agent — **do not** tell them to open the agent MCP tab unless `bound.mode` is `none` or install failed.
4. If they said «для всех» / "for everyone" / "shared", pass `bind: "shared"`.
5. If they only want the harness install (Settings already covers visibility later), pass `bind: "none"`.

## Do not

- Raw secret values in `env` (refused).
- Overwrite a bundled plugin name; pick another `name` or `replace: true` only for an existing **home** MCP.
- Flip the agent MCP tab manually after a successful bind — that was phase 1; auto-bind is the default now.

## After install

Read `bound` / `next` in the tool result. On the **next** model step the new tools should be in the tool list for this agent. If `started` is false, surface `startError` and suggest fixing the command/URL (or restart).

## See also

- Settings → **MCP** (plugin `mcp-catalog`) for human UI install.
- Core tool `mcp.install` / `POST /v1/plugins/mcp`.
