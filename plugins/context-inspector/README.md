# context-inspector

A view of an open chat, **Контекст**, next to **Чат** and **Журнал** in the chat header. It shows what went into the
prompt on every model step of that chat and where each part came from:
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

Restart `sinty web` and open a chat. Its header (top right) then shows **Чат · Журнал · Контекст**. **Контекст**
shows only that chat:
- The step list, «Ход N → Шаг M · tokens · +delta». The newest step opens on its own and the view follows new steps
  live, refreshing every 3 s while «обновлять» is on.
- Click an older step to pin it; click the last one to follow again.
- Each step shows its parts in order, colour-coded by kind with token counts. Click a row to see its full text.
- If you switch to another chat, the view stays on **Контекст** and shows that chat. Click **Чат** to go back.

**No snapshots yet?** Snapshots live in memory, from the moment the plugin started. A chat whose messages are older
than that, or any chat after a restart, shows «Для этого чата снимков пока нет»: they start with the next message.

To turn it off, remove the plugin from `plugins.inspect`, or from `plugins.enabled`, and restart.

## Security

- The manifest asks only for `permissions.context: ["inspect"]`: no network, no files, no secrets. `editable: false`
  means the agent cannot patch it.
- The core masks known secret values and secret-looking strings (API keys, tokens, private keys) in snapshots. This is
  best effort, so treat the tab as private.
- The page runs in a sandboxed iframe (opaque origin), and its CSP blocks all network access. It gets data only
  through the Web UI's `tab/1` bridge. The bridge forwards GET requests to this plugin's routes and adds the token:
  - `GET /p/context-inspector/tab`: the static page. This route is public and returns no data.
  - `GET /p/context-inspector/sessions`: sessions with snapshots. Needs the token. The tab no longer uses it, since
    it shows the open chat only, but it is kept for scripts.
  - `GET /p/context-inspector/snapshots?session=<id>`: step list for a session, without prompt text. Needs the token.
  - `GET /p/context-inspector/snapshots/<stepId>`: the full snapshot. Needs the token.

Spec: [`docs/spec/context-inspect.md`](../../docs/spec/context-inspect.md).

## Tests

`pnpm --filter @sinty/plugin-context-inspector test` covers the ring buffer, the summaries and the page CSP. It also
runs the page script against a fake DOM and bridge (`src/page.test.ts`), covering:
- init with a session;
- the empty state;
- live refresh;
- following and pinning steps;
- a chat switch with a stale reply dropped;
- no chat open. Core
tests: `packages/core/src/__tests__/context-inspect.test.ts` (snapshots) and `context-inspector-plugin.test.ts` (this
plugin end to end).
