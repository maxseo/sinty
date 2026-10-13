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
| Network | Per-plugin egress allowlist from the manifest plus the global `policy.yaml` allowlist |
| Shell | Disabled by default; when enabled runs in a sandbox (Docker / bubblewrap / restricted user) and defaults to `ask` |
| API | Bearer tokens with scopes (`read`, `chat`, `approve`, `admin`), per agent and per project; local mode binds to `127.0.0.1` |
| Self-modification | Only plugins and skills; via the patch pipeline with tests, health check and rollback; permission changes require human approval |

## Untrusted content

Tool results, fetched pages, files and inbound channel messages are wrapped as untrusted data in the model context. They cannot change policies or approve actions; approvals come only from authenticated clients with the `approve` scope.

## Audit

Every tool call with side effects, every approval and every plugin patch is an event in the append-only journal.
