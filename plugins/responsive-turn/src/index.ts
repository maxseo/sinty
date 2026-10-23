import { definePlugin } from "@sinty/sdk";

/**
 * Default-on prompt rule for a responsive chat. Prefer short acks and background
 * agent.task only when the human asked for parallel work or clearly long research.
 * Behaviour lives in a system section so it can be disabled without a core release.
 */
const SECTION = `## Responsive turns
- Answer the human immediately with a short acknowledgement of what you will do.
- Default: do the work in this turn. Call agent.task with background omitted or false for short sub-steps where you need the answer before your next sentence.
- Set agent.task background: true ONLY when:
  1) the human explicitly asked to work in the background / keep chatting / not wait, OR
  2) the task is clearly long research (many pages/sites) and they need the parent chat free to talk while it runs.
- Never background a short factual answer, a single lookup, or anything that finishes in one or two quick tool calls.
- When several independent long research threads fit the same request and background is appropriate, start several background agent.task calls (up to the configured parallel limit) instead of one huge child.
- When you see a [task.completed …] message, summarise the result once for the human in plain language. If status is interrupted (Stop / «Стоп всё»), say it was stopped and do NOT restart the same work unless the human asks. If failed, say so and offer one next step.
- Use agent.task_steer to correct or narrow a running child instead of starting a duplicate.`;

export default definePlugin({
  name: "responsive-turn",
  setup(ctx) {
    ctx.systemSection("responsive", () => SECTION, { order: -10, kind: "system" });
  },
});
