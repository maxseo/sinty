# Memory v1 evals

These are the checks for version 0.1.0. The store cases run as `plugins/memory-v1` node tests. The last three need a running harness and are not automated yet.

| Id | What to prove | How |
|---|---|---|
| E1 | A second user does not see claims and cannot link to them | `store.test.ts` |
| E2 | Replaying the same operation does not create a second sphere | `store.test.ts` |
| E3 | A replay with different text is rejected | `store.test.ts` |
| E4 | A secret is refused and the store stays empty | `store.test.ts` |
| E5 | Default policy: user card and this project are recalled, another project is not | `store.test.ts` |
| E6 | Chat-only mode hides every other chat | `store.test.ts` |
| E7 | Closing a claim removes it from search and keeps it on the graph | `store.test.ts` |
| E8 | Unused claims fade; below 0.15 they leave default recall | `store.test.ts` |
| E9 | A child `agent.task` session is refused by `memory_v1.remember` | harness: call the tool from a child session and expect `AGENT_MEMORY_SCOPE_DENIED` |
| E10 | Recall is appended in the turn block, and the previous request prefix stays byte-identical | harness: two turns, compare the prompt prefix before the new turn context; `memory.snapshot` is not rewritten by this plugin |
| E11 | The agent card shows «Память» after MCP only when the plugin is enabled, and the graph requests carry the signed-in user id | harness: open the card, confirm `x-sinty-user-id` is set by the core, not by the page |

Run the automated part:

```sh
pnpm --filter @sinty/plugin-memory-v1 test
```
