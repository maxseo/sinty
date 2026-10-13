# @sinty/core

The protected core. Milestone M1.

| Module | Spec |
|---|---|
| `loop/` — turn loop, budgets, interrupts | [architecture](../../docs/architecture.md#data-flow-of-one-step) |
| `registry/` — tool registry, schema validation | [plugin manifest](../../docs/spec/plugin-manifest.md) |
| `policy/` — policy gate and approvals | [policy](../../docs/spec/policy.md) |
| `journal/` — SQLite event log, checkpoints, resume | [journal](../../docs/spec/journal.md) |
| `host/` — plugin processes, permissions, hot reload, patch pipeline | [plugin manifest](../../docs/spec/plugin-manifest.md#patch-pipeline) |
| `api/` — HTTP, SSE, WebSocket, AG-UI mapping | [protocol](../../docs/spec/protocol.md) |
| `secrets/` — encrypted store and redaction | [security](../../SECURITY.md) |

Runtime dependencies are kept to a minimum: `node:sqlite`, `hono`, `zod`.
