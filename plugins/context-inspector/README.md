# context-inspector

A Web UI tab, **Контекст**, that shows what went into the prompt on every model step and where each part came from:
- the system prompt and the skills catalog;
- memory: the `memory.profile` facts with their tier, scope and source, the conversation summary, automatic recall
  (queries and records);
- what memory processor hooks did (`onTurnStart`, `afterRecall`, `beforeContext`);
- what plugin context contributors added or removed;
- the dialogue;
- the tool schemas;
- token estimates for every part and in total, for every step of every turn.

The plugin is disabled by default, and so are snapshots. It keeps the newest snapshots in memory only: by default
100, at most 64 MB. Nothing is written to disk, and everything is gone after a restart.

## Enable

Snapshots contain the whole prompt, private memory included, so the core sends them only to plugins the human lists
in `plugins.inspect`:

```yaml
plugins:
  enabled: [provider-openai-compat, tool-fs, ui-web, kanban, context-inspector]
  inspect: [context-inspector]
  config:
    context-inspector: { keep: 100, maxMb: 64 }   # optional
```

Restart `sinty web`. The left menu of the Web UI then shows **Контекст**. Send the agent a message, and every model
step appears in the list: «Ход N → Шаг M · tokens · +delta». Click a step to see its parts in order, colour-coded by
kind with token counts. Click a row to see its full text.

To turn it off, remove the plugin from `plugins.inspect`, or from `plugins.enabled`, and restart.

## Security

- The manifest asks only for `permissions.context: ["inspect"]`: no network, no files, no secrets. `editable: false`
  means the agent cannot patch it.
- The core masks known secret values and secret-looking strings (API keys, tokens, private keys) in snapshots. This is
  best effort, so treat the tab as private.
- The page runs in a sandboxed iframe (opaque origin), and its CSP blocks all network access. It gets data only
  through the Web UI's `tab/1` bridge. The bridge forwards GET requests to this plugin's routes and adds the token:
  - `GET /p/context-inspector/tab`: the static page. This route is public and returns no data.
  - `GET /p/context-inspector/sessions`: sessions with snapshots. Needs the token.
  - `GET /p/context-inspector/snapshots?session=<id>`: step list for a session, without prompt text. Needs the token.
  - `GET /p/context-inspector/snapshots/<stepId>`: the full snapshot. Needs the token.

Spec: [`docs/spec/context-inspect.md`](../../docs/spec/context-inspect.md).

## Tests

`pnpm --filter @sinty/plugin-context-inspector test` covers the ring buffer, the summaries and the page CSP. Core
tests: `packages/core/src/__tests__/context-inspect.test.ts` (snapshots) and `context-inspector-plugin.test.ts` (this
plugin end to end).
