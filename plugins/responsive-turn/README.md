# responsive-turn

Default-on context plugin. Adds a stable system-section rule:

1. Acknowledge the user immediately.
2. Send long work to `agent.task` with `background: true`.
3. Report when a `task.completed` event arrives.
4. Steer running children with `agent.task_steer`.

Disable it with `plugins.disabled: [responsive-turn]` (or exclude it on an agent card) if a persona should keep the old blocking style.
