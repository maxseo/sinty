# memory.write through the tool now emits memory.written

- Date: 2026-10-20
- Area: packages/core (memory-router.ts)
- Plan step: follow-up to memory plan step 4; known deviation "tool writes do not emit memory.written"
- Commits: `feat(memory): recall OR/prefix fallback, journaled tool writes, sinty memory reindex` (one commit for the three memory changes, docs/spec/memory.md and CHANGELOG)

## What and why

`MemoryRouter.tool("memory.write")` called `write(..., { journal: false })`. Only summary, processor and
afterTurn writes produced `memory.written`; a fact the agent stored itself was visible only as
`tool.call.completed`. As a result:
- queries over `memory.%` events missed most writes;
- the Web UI journal tab could not show them;
- plugins subscribed to `memory.written` never saw them.

Now the tool path passes `journal: true`. Every builtin write emits exactly one event:
`memory.written { id, action: inserted|updated, tier, scope, source, provider: "builtin:sqlite" }`.
A write dropped by an `onWrite` processor already emitted `memory.written { action: "dropped", by }` and still emits
only that one event.

## Files touched

- `packages/core/src/memory-router.ts`: one argument in `tool()`.
- `packages/core/src/__tests__/memory-router.test.ts`: test `router: memory.write through the tool journals
  memory.written once per write`. It writes the same sentence twice and expects `inserted` then `updated`, the same
  id, and that id in the tool result.

## Design decisions

- The event is emitted in the shared write path, not in the agent, so every way of writing produces the same event.
- `by` is omitted for tool writes; it names a plugin that changed or dropped the write. `source` stays as given by
  the tool (`agent` by default).
- The event carries no `turnId`, like other memory events today (`MemoryRouter` records by session).

## Migration notes

None. Journals written before this change simply have no `memory.written` for old tool writes.

## Known limitations

- Mirrored writes to `memory.writeTo` providers are not journaled separately; the event describes the builtin write.

## How to test

- `node --test packages/core/dist/__tests__/memory-router.test.js`.
- SQL:
  `SELECT type, data FROM events WHERE type='memory.written' ORDER BY ts DESC LIMIT 5;`
  After the agent calls `memory.write`, a row with `"source":"agent"` appears.
