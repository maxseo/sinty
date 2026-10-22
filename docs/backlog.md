# Backlog: planned for future updates

Things that are designed or promised in the docs but not built yet, and are not part of a milestone in the [roadmap](roadmap.md). Each item says why it is needed and what changes in the agent once it exists.

## Done (removed from this list)

Built since the last backlog update; details in the [roadmap](roadmap.md#done-after-10-october-2026) and the
[journal](journal/README.md).

- `tool-web` (search, read, screenshot through the core network guard) — [#8](https://github.com/maxseo/sinty/pull/8), [#9](https://github.com/maxseo/sinty/pull/9), [#10](https://github.com/maxseo/sinty/pull/10).
- `skills` loader (`SKILL.md`) as a plugin — [#11](https://github.com/maxseo/sinty/pull/11).
- Sandboxed shell on Linux (bubblewrap; shell stays a core tool) — [#17](https://github.com/maxseo/sinty/pull/17).
- Context window from the model list (`memory.contextTokens: auto`) and the compaction cap `memory.compactCapTokens` — [#14](https://github.com/maxseo/sinty/pull/14); `sinty doctor` line — [#18](https://github.com/maxseo/sinty/pull/18).
- Re-embed after an embedding model change — [#12](https://github.com/maxseo/sinty/pull/12).
- Better stemming for recall (Snowball / porter) — [#13](https://github.com/maxseo/sinty/pull/13).
- Login token rotation — [#15](https://github.com/maxseo/sinty/pull/15).
- No `--allow-child-process` SecurityWarning in plugin logs — [#16](https://github.com/maxseo/sinty/pull/16).

## Tools and plugins

### Shell sandbox on macOS
- **Why:** `shell.run` runs in a sandbox on Linux (bubblewrap, [#17](https://github.com/maxseo/sinty/pull/17)) and on Windows (`ShellBox`), but not on macOS (`sandbox-exec` is deprecated).
- **Effect on the agent:** commands on a Mac cannot write outside the workspace or reach the network, the same as on the other systems.
- Linux leftovers: tool folders on `PATH` are read-only (nvm/pyenv setups that write beside their binaries fail); `HOME` is the workspace, so dotfiles land there.

### Browser helper for `tool-web`
- **Why:** `permissions.browser` implies `--allow-child-process`, which Node cannot narrow; a patched `tool-web` could start other programs. Raw `net.connect` from plugin code is not blocked either (true for every plugin).
- **Effect on the agent:** none in behaviour. The browser would run in a non-editable helper, so a patched plugin could not use the child-process right for anything else.
- Smaller `tool-web` leftovers: `blockedReason()` is word-based (captcha pages with other wording and status 200 pass); target detection for repeats is a fixed list of argument names.

### `mcp-stdio` and `http` plugin runtimes
- **Why:** thousands of tools already exist as MCP servers (GitHub, databases, browsers); writing Sinty plugins for each is wasteful.
- **Effect on the agent:** any MCP server becomes a plugin through its manifest. Its tools appear in the registry with the same policy, journal and supervisor as native tools.

### Attachments (`BlobRef`)
- **Why:** users send images, PDFs and spreadsheets; tools produce files.
- **Effect on the agent:** messages and tool results can carry files stored in `blobs/`. Models that support images get them as input.

### Message queue per session
- **Why:** today a second message while a turn runs returns `409 turn_active`.
- **Effect on the agent:** messages sent while it works are queued and added to the running turn at the next step. The user can correct the agent mid-task without interrupting it.

### Model routes (`cheap`, per-task)
- **Status:** partly built. `models.routes.cheap` and `models.routes.embed` are used by plugins through `ctx.models` (core `ModelGateway`). Still open: route the core's own summaries and incident notes through `cheap` by default (today they use `service.model` or the speaker's model).

### Untested path: compressed body with `truncate`
- **Why:** in `tool-web` with `truncate`, a compressed body that passes 4 × `maxBytes` before its decoded size does returns what the decoder produced so far. No test covers it (it needs a body that compresses worse than 4:1 while arriving faster than it decodes); see `2026-10-21-web-errors-supervisor-notices`.
- **Effect on the agent:** none expected; a test would prove that a large compressed page is cut cleanly.

### SecurityWarning on old Node 24
- **Why:** on Node releases that print the `--allow-child-process` warning without a code, the fallback hides every SecurityWarning of that plugin process ([#16](https://github.com/maxseo/sinty/pull/16)).
- **Effect on the agent:** none; other security warnings of such a plugin would be visible again once the filter can match by message only.

### Checkpoints
- **Why:** resume rebuilds a turn from all of its events; very long turns get slow to resume.
- **Effect on the agent:** none in behaviour. Restarts after a crash become faster for long turns.

## Memory and context

Cross-session memory is built (core `MemoryRouter` + builtin SQLite store, see [plan.md](plan.md),
[spec/memory.md](spec/memory.md) and the [journal](journal/README.md)). Still open:

### Embeddings are not configured by default
- **Why:** vector recall needs an embedding route. `models.routes.embed` is empty by default, so recall is full-text (FTS5 with stemming) only and the vector table stays empty. A new install does not say so anywhere except `sinty doctor`.
- **Effect on the agent:** with embeddings it finds facts by meaning, not only by shared words (paraphrases, other languages).
- **How to enable today:**
  1. Add an OpenAI-compatible provider that serves `/embeddings` (DeepSeek and Anthropic do not), with its key as a `secret://` reference.
  2. Set the route and the width in `config.yaml`, for example `models.routes.embed: openai/text-embedding-3-small` and `memory.dimensions: 1536` (the width must match the model).
  3. Run `sinty memory reembed --dry-run`, then `sinty memory reembed` to embed existing facts, or set `memory.reembed: auto` to do it in the background on start.
  4. Check with `sinty doctor` (no stale-vector or width warning).
- **Open:** decide whether `sinty init` or Settings should offer this, and whether `doctor` should print an explicit "vector recall: off" line.

### Memory follow-ups
- **Vault embeddings:** `memory-obsidian` is lexical (BM25); semantic search through `ctx.models.embed` would find paraphrases.
- **Memory UI:** browse, edit and forget facts and see `memory.*` events in the Web UI.
- **Eval datasets:** `sinty memory eval` needs labeled query sets per install to be useful for tuning. Eval uses `config.agent.name` as the persona, so other personas' agent- and chat-scoped facts are not visible to it.
- **Experiments:** arms override recall settings and providers only, not processors or compaction.
- **Recall budget** is counted as characters / 4, which undercounts Cyrillic; the same estimate drives compaction (see the context window ratio, [#14](https://github.com/maxseo/sinty/pull/14)).
- **Stemming:** no stop-word list; mixed-script words (e.g. "PRы") stay unstemmed.
- **Embeddings in other providers:** only `provider-openai-compat` implements `embed()`; `provider-openai-responses` could reuse the same endpoint.

### Re-embed: base URL change is not detected
- **Why:** `facts_vec_meta` records the embed route string (`provider/model`) and width. Pointing the same provider id to another server (`providers.<id>.baseUrl`) with the same model name keeps the old vectors marked current.
- **Effect on the agent:** after such a change recall would not mix vectors of two different models. Fix: include the base URL (or a hash) in the stored model key, or let `sinty memory reembed --all` force a rebuild.
- Related: with more than ~4000 stale vectors the KNN window (4096) can miss current neighbours until the re-embed finishes.

### Memory queue for disabled plugins
- **Why:** `afterTurn` jobs of a plugin that is never re-enabled stay `pending` forever (visible via `MemoryRouter.jobs()`).
- **Effect on the agent:** none; the queue would not grow without bound.

### Context inspector extras
- **Why:** the «Контекст» tab shows one snapshot at a time; finding why a prompt grew or the cache broke is manual.
- **Effect on the agent:** none in behaviour; faster debugging for the human. Items: search and filter inside a step; export a snapshot as JSON; side-by-side diff of two steps (beyond the token delta and cache boundary); snapshots persisted across restarts (history is per process and capped by `keep` / `maxMb`, and `cache.reused` has no comparison for the first step after a restart); timings for `onCompaction` and `afterTurn`.

### Fallback window check follow-ups
The fallback check ([#14](https://github.com/maxseo/sinty/pull/14)) trims or skips a fallback route whose window is too small for the primary-sized prompt. Open:
- The token ratio (estimate vs real) is per chat, not per model, and lags one step; a fallback with another tokenizer gets the primary's ratio.
- A route with an unknown window (`fallback` source, 128000 is a guess) is trimmed when needed but never skipped.
- Compaction uses the first route's window; a fallback much smaller than the primary can still be skipped, and the context snapshot shows the primary request only.
- DeepSeek and OpenAI model lists carry no windows; models missing from the built-in table use 128000 until `models.contextWindows` is set. Anthropic's list is read as one page (up to 1000 models).

### `context-compress`
- **Status:** compaction is built into the core memory router: summary at min(65 % of the window, `memory.compactCapTokens`, default 150000), window from the model list (`memory.contextTokens: auto`), last 12 user turns kept, `onCompaction` hook for plugins, trim-to-window on failure. A separate plugin is no longer planned. When the summary fails, the prompt is trimmed on every turn until a summary succeeds, which breaks the cache prefix each turn.

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
- **Includes the compaction cap by money (variant 2).** Today the compaction point is capped in tokens (`memory.compactCapTokens`, variant 1, [#14](https://github.com/maxseo/sinty/pull/14)). Variant 2 would derive the cap from the price per input token and a per-request cost limit, so expensive models compact earlier. It needs the same price table, so it is planned together with USD budgets.

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

### Token rotation leftovers
- Login token rotation is built ([#15](https://github.com/maxseo/sinty/pull/15)). Open: long-lived streams served by plugins under `/p/:plugin/*` are authorized once and are not closed on rotation (their next reconnect gets `401`); a rotation by another process reaches open core streams on the next 15 s ping; two processes writing secrets at the same moment can still lose one write.

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
