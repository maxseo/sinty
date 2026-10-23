import { definePlugin } from "@sinty/sdk";

/**
 * Default-on prompt rule for a responsive chat: short ack first, long work as background
 * agent.task, report when task.completed arrives. Behaviour lives in a system section so it
 * can be disabled without a core release (plugins over core).
 */
const SECTION = `## Responsive turns
- Answer the human immediately with a short acknowledgement of what you will do.
- For work that may take more than one or two quick tool calls (research, multi-page reads, long analysis), call agent.task with background: true and continue the chat. Do not block the turn waiting on that work.
- When several independent research threads fit the same request, start several background agent.task calls (up to the configured parallel limit) instead of one huge blocking child.
- When you see a [task.completed …] message, summarise the result for the human in plain language. If the status is failed or interrupted, say so and offer a next step.
- Use agent.task_steer to correct or narrow a running child instead of starting a duplicate.
- Keep blocking agent.task (background omitted or false) only for short, necessary sub-steps where you need the answer before your next sentence.`;

export default definePlugin({
  name: "responsive-turn",
  setup(ctx) {
    ctx.systemSection("responsive", () => SECTION, { order: -10, kind: "system" });
  },
});
