# Backlog: planned for future updates

Things that are designed or promised in the docs but not built yet, and are not part of a milestone in the [roadmap](roadmap.md). Each item says why it is needed and what changes in the agent once it exists.

## Tools and plugins

### `tool-shell` (sandboxed)
- **Why:** run commands, scripts, builds and tests: the most common thing a working agent needs after files.
- **Effect on the agent:** it can execute programs in the workspace. Every command goes through the policy (`ask` by default). In `strict` mode commands run in a container, so a bad command cannot harm the host.

### `tool-web` (search and fetch)
- **Why:** answers often need fresh information from the internet.
- **Effect on the agent:** it can search and read pages. Requests reach only hosts allowed in `policy.yaml`, and page text is marked as untrusted, so instructions inside a page are not followed.

### Memory follow-ups
Cross-session memory is built (core `MemoryRouter` + builtin SQLite store, see [spec/memory.md](spec/memory.md) and
`docs/journal/`). Still open:
- **Vault embeddings:** `memory-obsidian` is lexical (BM25); semantic search through `ctx.models.embed` would find paraphrases.
- **Better stemming:** recall uses a crude prefix stem for OR fallback; a per-language stemmer (Snowball) or embeddings would match more forms with less noise.
- **Memory UI:** browse, edit and forget facts and see `memory.*` events in the Web UI.
- **Eval datasets:** `sinty memory eval` needs labeled query sets per install to be useful for tuning.

### `skills` loader (`SKILL.md`)
- **Why:** repeatable procedures (publish an article, check a payment) are better written once than explained in every chat.
- **Effect on the agent:** it loads matching skills into the prompt and can write new skills to `skills/` itself. Its behaviour improves without code changes.

### `context-compress`
- **Status:** compaction is built into the core memory router (summary at 65% of `memory.contextTokens`, last 12 user turns kept, `onCompaction` hook for plugins, trim-to-window on failure). A separate plugin is no longer planned.

### `mcp-stdio` and `http` plugin runtimes
- **Why:** thousands of tools already exist as MCP servers (GitHub, databases, browsers); writing Sinty plugins for each is wasteful.
- **Effect on the agent:** any MCP server becomes a plugin through its manifest. Its tools appear in the registry with the same policy, journal and supervisor as native tools.

### Attachments (`BlobRef`)
- **Why:** users send images, PDFs and spreadsheets; tools produce files.
- **Effect on the agent:** messages and tool results can carry files stored in `blobs/`. Models that support images get them as input.

### Message queue per session
- **Status:** a message during a running turn is appended to that turn and the next model step sees it. A turn blocked on an approval still returns `409 turn_active`. Settings → Основные → «Enter, пока агент занят» chooses queue or interrupt.

### Model routes (`cheap`, per-task)
- **Status:** partly built. `models.routes.cheap` and `models.routes.embed` are used by plugins through `ctx.models`. Settings → Модели saves `embed`, vector width and `decision` (`decision` is not called by the turn yet). Still open: route the core's own summaries and incident notes through `cheap` by default.

### Checkpoints
- **Why:** resume rebuilds a turn from all of its events; very long turns get slow to resume.
- **Effect on the agent:** none in behaviour. Restarts after a crash become faster for long turns.

## Supervisor and self-repair

### `stall` detector
- **Why:** a turn can hang without errors, for example a tool that never answers within its long timeout, or a model that keeps thinking.
- **Effect on the agent:** after `stallSeconds` without progress it gets a notice, and then the turn escalates to a human. No more silently stuck turns.

### `provider` detector
- **Why:** a provider can be slow or flaky without failing outright, and the core falls back only on hard errors.
- **Effect on the agent:** it switches to the fallback model when the error rate or latency is high, so fewer turns fail during provider incidents.

### Model-written incident summaries and similarity search
- **Why:** today an incident is "these arguments worked", matched exactly on tool and error code.
- **Effect on the agent:** hints after a failure explain what was wrong and how it was fixed. They also match similar errors, not only identical ones, so the agent repeats fewer mistakes.

### New plugins through the patch pipeline
- **Why:** the agent can fix existing plugins but cannot add a new tool when it needs one.
- **Effect on the agent:** it can write a new plugin. That plugin goes through the same tests and git history, and a human approves its first permissions. The agent extends its own abilities safely.

### Auto-apply mode for patches
- **Why:** on a trusted personal machine, approving every small fix is tedious.
- **Effect on the agent:** with `plugin.apply_patch: allow`, it fixes plugins on its own when the tests pass. Permission changes still need a human, and the canary still rolls back.

### Supervisor-driven model fallback
- **Why:** some models repeatedly return empty or broken output for a specific task.
- **Effect on the agent:** after repeated `bad_output` notices, the next step uses the fallback model instead of retrying the same one.

### Crash test with `kill -9` in CI
- **Why:** crash recovery is tested by simulating the journal state; a real kill of the process proves it end to end.
- **Effect on the agent:** none in behaviour. Regressions in crash recovery are caught before release.

## Security and limits

### OS-level network control (`strict` mode)
- **Why:** in `standard` mode the network allowlist is enforced inside the plugin process by replacing `fetch`; a malicious plugin could open sockets with `node:net`.
- **Effect on the agent:** plugins physically cannot reach hosts outside the allowlist, even if their code is hostile. This matters most on a VPS.

### Budgets in USD
- **Why:** step and token limits do not map to money, and prices differ by model.
- **Effect on the agent:** a turn, a session or a day stops at a money limit, using a price table per model. Runaway costs become impossible.

### Approvals from channels
- **Why:** approvals now come only from the API and the Web UI.
- **Effect on the agent:** the human can approve or deny a call with a button in Telegram or another channel, so the agent waits less when the human is away from the computer. Only non-editable channel plugins get this right.

### Agent-proposed edits to `AGENTS.md`
- **Why:** the agent learns things about how the user wants it to work, but cannot record them in its rules.
- **Effect on the agent:** it proposes a change to `AGENTS.md`, and the human approves or rejects it. Its rules improve over time, and the human stays in control.

## Servers and UI leftovers

### API token scopes (`read`, `chat`, `approve`, `admin`)
- **Why:** today one bearer token can do everything; sharing it with a dashboard or an MCP client is all-or-nothing.
- **Effect on the agent:** a client can be limited to watching, chatting, or approving. Stolen or leaked tokens do less damage.

### WebSocket multiplex (`/v1/ws`)
- **Why:** some clients prefer one socket over several SSE streams.
- **Effect on the agent:** none in behaviour. The same events are already on `/v1/stream` and per-session SSE.

### AG-UI tools defined by the frontend
- **Why:** CopilotKit and similar UIs send tools the app itself executes (`input.tools`).
- **Effect on the agent:** it can call those app tools in a turn, the same way it calls Sinty plugins. The app stays in control of what those tools do.

### Single executable (Node SEA)
- **Why:** a directory install still needs Node.js 24 next to the files.
- **Effect on the agent:** none in behaviour. `sinty` would be one file, but plugins, the UI and `node_modules` would still sit beside it, because the host loads them from disk.

### Channel runtime (`ctx.channel`)
- **Why:** channel plugins today are HTTP routes. A channel runtime would deliver inbound messages and push `message.agent` back out without each plugin subscribing by hand.
- **Effect on the agent:** Telegram and webhooks keep working the same. New channels get a shorter setup, and outbound replies stay consistent when the human is not waiting on the HTTP call.

### Open the browser from `sinty web`
- **Why:** the command already prints a URL with `#token=`; opening it saves a copy-paste.
- **Effect on the agent:** none. The human reaches the UI one step faster.
