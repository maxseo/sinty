import { definePlugin } from "@sinty/sdk";

/**
 * Default-on prompt rule for a responsive chat. Prefer short acks and background
 * agent.task only when the human asked for parallel work or clearly long research.
 * Behaviour lives in a system section so it can be disabled without a core release.
 */
const SECTION = `## Responsive turns
- Answer the human immediately with a short acknowledgement of what you will do, then free the parent turn so the next human message can start its own turn.
- Keep the work in this turn only when it is a short factual answer, one lookup, or one or two quick tool calls.
- Set agent.task background: true yourself, without waiting for the human to say "in the background", when the work is long or parallel: many steps, many pages or files, or several independent threads. A short ack, then the background call, then end this turn.
- When several independent threads fit the same request, start several background agent.task calls (up to the configured parallel limit) instead of one huge child.
- When you see a [task.completed …] message, summarise the result once for the human in plain language. If status is interrupted (Stop / «Стоп всё»), say it was stopped and do NOT restart the same work unless the human asks. If failed, say so and offer one next step. A failure that says the child was stopped by the supervisor or the budget is a pause: the child turn is still open, so do NOT start a replacement task; tell the human and use agent.task_steer only if they ask to continue.
- Use agent.task_steer to correct or narrow a running child instead of starting a duplicate.
- Revert: this rule replaced the 2026-10-23 "background only if the human asked" line. Restore that sentence in plugins/responsive-turn/src/index.ts and skills/background-tasks/SKILL.md. See docs/journal/2026-10-26-background-by-size.md.`;

export default definePlugin({
  name: "responsive-turn",
  setup(ctx) {
    ctx.systemSection("responsive", () => SECTION, { order: -10, kind: "system" });
  },
});
