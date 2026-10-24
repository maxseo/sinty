import { definePlugin } from "@sinty/sdk";

/**
 * Owns Settings → MCP (manifest settings). The actual pane is apps/web mcp-pane.tsx,
 * which calls core POST /v1/plugins/mcp — this plugin does not reimplement install.
 */
export default definePlugin({
  name: "mcp-catalog",
  setup() {
    // Settings section comes from sinty.plugin.json; no tools or HTTP needed for phase 2.
  },
});
