# responsive-turn

Default-on context plugin. Adds a stable system-section rule:

1. Acknowledge the user immediately.
2. Do short work in the same turn (`agent.task` without `background`, or direct tools).
3. Use `agent.task` with `background: true` **only** when the human asked for parallel/background work, or for clearly long research while they keep chatting.
4. Report when a `task.completed` event arrives.
5. Steer running children with `agent.task_steer`.

Disable it with `plugins.disabled: [responsive-turn]` (or exclude it on an agent card) if a persona should keep a different style.
