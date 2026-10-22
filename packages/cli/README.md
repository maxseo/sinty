# sinty (CLI)

Milestone M1.

| Command | Does |
|---|---|
| `sinty init [--mode standard\|strict]` | create `$SINTY_HOME` with config, policy, plugin repo |
| `sinty web [--port 3180] [--no-open]` | run the agent with the Web UI |
| `sinty run "<prompt>"` | headless single turn, prints the answer |
| `sinty attach <sessionId>` | attach a terminal to a session (used by Herdr resume) |
| `sinty connect <url> --token <t>` | register this agent with an external system |
| `sinty mcp` | run as an MCP server over stdio |
| `sinty secret set\|list\|rm <name>` | manage the encrypted secret store |
| `sinty token [rotate [--print]]` | print the login token, or replace it (the old one stops working at once) |
| `sinty plugin add\|list\|disable <name>` | manage plugins |
| `sinty service install` | systemd / launchd / Windows service |
| `sinty upgrade` | update the core, verify integrity |
| `sinty doctor` | check config, permissions, providers, plugins |
