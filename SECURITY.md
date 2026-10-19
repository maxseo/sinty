# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability"). We aim to answer within 72 hours.

## Threat model

Sinty assumes the **model is untrusted**: it may be wrong, manipulated by prompt injection in tool output, or actively try to escape. Protection never relies on the system prompt.

| Asset | Protection |
|---|---|
| Core code | Installed read-only; integrity hashes checked on start; updated only by `sinty upgrade` run by a human |
| Policies, config, journal | Owned by the core process; no tool can write them |
| Secrets | Encrypted store; tools receive values by `secret://` reference at call time; values are redacted from events and logs |
| Host filesystem | Plugins run as separate processes under the Node.js permission model; writes limited to declared roots; `strict` mode uses separate OS users |
| Network | Per-plugin egress allowlist from the manifest plus the global `policy.yaml` allowlist. In `standard` mode it is enforced inside the plugin process (`fetch` is replaced); a plugin that opens raw sockets bypasses it. `strict` mode (M5) adds OS-level egress control |
| Shell | Disabled by default; when enabled runs in a sandbox (Docker / bubblewrap / restricted user) and defaults to `ask` |
| API | Bearer token; local mode binds to `127.0.0.1`. Plugin routes inherit the same check unless marked `public`. The core strips `Authorization`, `Cookie` and hop-by-hop headers (and the `token` query) before the plugin sees the request |
| Plugin agent API | A plugin may call sessions only if `permissions.agent` lists `sessions.read` and/or `sessions.write`. The core validates arguments; the plugin cannot invent ops |
| Web UI | Served only from plugins with `editable: false` (the agent cannot patch the files that hold the token). Strict CSP: scripts from this origin only, `frame-ancestors 'none'`. The token lives in `localStorage` after `#token=` |
| Self-modification | Only plugins and skills; via the patch pipeline: a staging copy, tests run under the plugin's own permissions, a git commit per change, a health check and automatic rollback; applying needs approval by default, and permission changes always need it |

## Untrusted content

Tool results, fetched pages, files and inbound channel messages are wrapped as untrusted data in the model context. They cannot change policies or approve actions; approvals come only from authenticated clients with the `approve` scope.

## Audit

Every tool call with side effects, every approval and every plugin patch is an event in the append-only journal.
