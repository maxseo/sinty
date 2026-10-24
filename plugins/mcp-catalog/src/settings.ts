/** Plugin settings (manifest config merged with config.yaml plugins.config.mcp-catalog). */
export interface McpCatalogSettings {
  /** Include MCP plugins that are off in plugins.enabled. */
  showDisabled: boolean;
}

export function readSettings(config: Readonly<Record<string, unknown>>): McpCatalogSettings {
  return { showDisabled: config.showDisabled !== false };
}
