# mcp-catalog

Settings section **MCP**: list home/bundled plugins with `runtime: mcp-stdio` | `http`, enable/disable, and add a custom MCP via the core `POST /v1/plugins/mcp` API (same shape as `mcp.install`).

The Web UI pane lives in `apps/web` (`mcp-pane.tsx`) and is wired when the section id is `plugin.mcp-catalog`. This plugin only owns the settings section registration (and a `showDisabled` toggle).

Out of scope: curated one-click catalog, skill auto-install, OAuth, per-agent auto-bind.
