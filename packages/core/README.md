# @sinty/core

The protected core.

| File | Does | Spec |
|---|---|---|
| `agent.ts` | turn loop, core tools (`ask_human`, `context.recall`), budgets, approvals, resume; state is rebuilt from the journal on every step | [architecture](../../docs/architecture.md#data-flow-of-one-step) |
| `journal.ts` | SQLite (WAL, `synchronous=FULL`) events, sessions, turns, idempotency keys | [journal](../../docs/spec/journal.md) |
| `policy.ts` | `allow` / `ask` / `deny`, hard filesystem rules, host allowlists | [policy](../../docs/spec/policy.md) |
| `host/host.ts` | one process per plugin under `--permission`, handshake, timeouts, cancel, restart with backoff | [plugin manifest](../../docs/spec/plugin-manifest.md) |
| `host/runner.ts` | code inside the plugin process: `PluginContext`, zod validation, guarded `fetch` | |
| `host/manifest.ts` | manifest validation, `$WORKSPACE` / `$SKILLS` grants, refusal of grants on core files | |
| `api/server.ts` | HTTP API and SSE stream (Hono) | [protocol](../../docs/spec/protocol.md) |
| `secrets.ts` | AES-256-GCM store, `secret://` refs, redaction before journal writes | [security](../../SECURITY.md) |
| `sinty.ts` | wiring and `initHome()` | |

Runtime dependencies: `hono`, `@hono/node-server`, `yaml`, `zod` (via `@sinty/sdk`), `node:sqlite`.

```sh
pnpm test   # 18 tests: loop, approvals, deny, invalid args, ask_human, plugin crash, interrupt,
            # provider fallback, crash recovery, sandbox escape attempts, API, journal, policy
```
