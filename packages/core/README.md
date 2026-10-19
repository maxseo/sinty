# @sinty/core

The protected core.

| File | Does | Spec |
|---|---|---|
| `agent.ts` | turn loop, budgets, approvals, supervisor checkpoints, resume; state is rebuilt from the journal on every step | [architecture](../../docs/architecture.md#data-flow-of-one-step) |
| `coretools.ts` | `ask_human`, `context.recall`, `plugin.list`, `plugin.read`, `plugin.propose_patch`, `plugin.apply_patch` | [plugin manifest](../../docs/spec/plugin-manifest.md#patch-pipeline) |
| `patches.ts` | patch pipeline: staging copy, sandboxed tests, git commit, hot reload, canary, rollback | [plugin manifest](../../docs/spec/plugin-manifest.md#patch-pipeline) |
| `supervisor-client.ts` | runs `@sinty/supervisor` as a read-only child process; checkpoints with a 3 s timeout | [supervisor](../../docs/spec/supervisor.md) |
| `journal.ts` | SQLite (WAL, `synchronous=FULL`) events, sessions, turns, idempotency keys, incidents, patches | [journal](../../docs/spec/journal.md) |
| `policy.ts` | `allow` / `ask` / `deny`, hard filesystem rules, host allowlists | [policy](../../docs/spec/policy.md) |
| `host/host.ts` | one process per plugin under `--permission`, handshake, timeouts, cancel, restart with backoff, reload | [plugin manifest](../../docs/spec/plugin-manifest.md) |
| `host/runner.ts` | code inside the plugin process: `PluginContext`, zod validation, guarded `fetch` | |
| `host/manifest.ts` | manifest validation, `$WORKSPACE` / `$SKILLS` / `$DATA` grants, refusal of grants on core files and other plugins' data | |
| `plugin-bridge.ts` | plugin → agent API: scopes, zod, idempotency prefix | |
| `api/server.ts` | HTTP API, SSE, plugin routes `/p/`, static UI `/ui/` | [protocol](../../docs/spec/protocol.md) |
| `secrets.ts` | AES-256-GCM store, `secret://` refs, redaction before journal writes | [security](../../SECURITY.md) |
| `sinty.ts` | wiring and `initHome()` | |

Runtime dependencies: `hono`, `@hono/node-server`, `yaml`, `zod` (via `@sinty/sdk`), `node:sqlite`, `git` for plugin patches.

```sh
pnpm test   # loop, approvals, deny, invalid args, ask_human, plugin crash, interrupt,
            # provider fallback, crash recovery, sandbox, API, journal, policy,
            # supervisor, patches, plugin HTTP/agent scopes/static UI, kanban, MCP, OpenAI API, Responses provider
```
