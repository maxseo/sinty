import { definePlugin } from "@sinty/sdk";

/**
 * Default-on prompt rule for a responsive chat: a short acknowledgement first,
 * long or parallel work as a background agent.task started without being asked.
 * Behaviour lives in a system section so it can be disabled without a core release.
 *
 * The thresholds are numbers on purpose: "long or parallel" was a judgement call and the
 * model usually stayed in the turn. The same numbers live in skills/background-tasks/SKILL.md
 * and in docs/journal/2026-11-09-background-thresholds.md - change all three together.
 * Rationale and the revert procedure stay in docs/journal, never in SECTION: the model
 * must not read how to undo its own rule.
 */
const SECTION = `## Responsive turns
- Answer the human immediately with one short plain-text line saying what you will do, in the same step as the first tool call. A step that only calls tools shows the human an empty chat.
- Count the job before the first call. Stay in this turn when it is at most 2 tool calls and at most 1 page, file or site to read. With no tool needed, just answer.
- Use agent.task with background: true yourself, without waiting for the human to say "in the background", as soon as any of these holds: 3 or more tool calls; 2 or more pages, files or sites to read; 2 or more independent threads; or the job cannot finish inside this turn.
- With 2 or more independent threads start one background agent.task per thread (up to the configured parallel limit) instead of one large child.
- When a [task.completed …] message arrives, summarise the result once for the human in plain language. If status is interrupted (Stop / «Стоп всё»), say it was stopped and do NOT restart the same work unless the human asks. If failed, say so and offer one next step. A failure that says the child was stopped by the supervisor or the budget is a pause: the child turn is still open, so do NOT start a replacement task; tell the human and use agent.task_steer only if they ask to continue.
- Use agent.task_steer to correct or narrow a running child instead of starting a duplicate.`;

export default definePlugin({
  name: "responsive-turn",
  setup(ctx) {
    ctx.systemSection("responsive", () => SECTION, { order: -10, kind: "system" });
  },
});
