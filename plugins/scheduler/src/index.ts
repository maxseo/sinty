import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, ToolError, z } from "@sinty/sdk";
import { cronBetween, cronDue, parseCron } from "./cron.js";
import { computeNext, JobStore, newJobId, type ScheduleJob } from "./store.js";

const createInput = z
  .object({
    name: z.string().min(1).max(80).optional(),
    sessionId: z.string().min(1).max(80).optional(),
    text: z.string().min(1).max(20_000),
    cron: z.string().min(9).max(64).optional(),
    at: z.string().min(10).max(40).optional(),
    delaySeconds: z.number().int().min(1).max(60 * 60 * 24 * 30).optional(),
  })
  .refine((v) => [Boolean(v.cron), Boolean(v.at), v.delaySeconds != null].filter(Boolean).length === 1, {
    message: "provide exactly one of delaySeconds, at, or cron",
  });

function wakeText(job: ScheduleJob, when: Date): string {
  const whenIso = when.toISOString();
  const kind = job.kind === "cron" ? `cron ${job.cron}` : `at ${job.at}`;
  return `[scheduler] Сработало «${job.name}» (${job.id}, ${kind}) в ${whenIso}. Выполни указание ниже в этом чате и не рассказывай про планировщик.\n\n${job.text}`;
}

function appendWake(dir: string, row: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "wakes.jsonl"), `${JSON.stringify(row)}\n`);
}

let stopTimer: (() => void) | undefined;

export default definePlugin({
  name: "scheduler",
  setup(ctx) {
    const store = new JobStore(ctx.paths.data);
    const tickRaw = Number(ctx.config.tickMs ?? 1_000);
    const tickMs = Number.isFinite(tickRaw) ? Math.min(60_000, Math.max(1_000, Math.floor(tickRaw))) : 10_000;
    let timer: ReturnType<typeof setInterval> | undefined;
    let pumping = false;

    const publicJob = (j: ScheduleJob) => ({
      id: j.id,
      name: j.name,
      kind: j.kind,
      cron: j.cron ?? null,
      at: j.at ?? null,
      sessionId: j.sessionId,
      text: j.text,
      enabled: j.enabled,
      createdAt: j.createdAt,
      lastRunAt: j.lastRunAt,
      nextRunAt: j.nextRunAt,
      runCount: j.runCount,
    });

    async function fire(job: ScheduleJob, now: Date): Promise<void> {
      const session = await ctx.agent.getSession(job.sessionId);
      if (!session) {
        ctx.log.warn("scheduler skip: session gone", { jobId: job.id, sessionId: job.sessionId });
        job.enabled = false;
        job.nextRunAt = null;
        store.upsert(job);
        appendWake(ctx.paths.data, { ts: now.toISOString(), jobId: job.id, status: "session_missing", sessionId: job.sessionId });
        return;
      }
      const slot = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}T${now.getHours()}:${now.getMinutes()}`;
      const idem = `scheduler:${job.id}:${job.kind === "at" ? job.at : slot}`;
      const text = wakeText(job, now);
      try {
        const { turnId } = await ctx.agent.send(job.sessionId, text, { channel: "schedule", idempotencyKey: idem });
        job.lastRunAt = now.toISOString();
        job.runCount += 1;
        if (job.kind === "at") {
          job.enabled = false;
          job.nextRunAt = null;
        } else {
          job.nextRunAt = computeNext(job, now);
        }
        store.upsert(job);
        appendWake(ctx.paths.data, {
          ts: now.toISOString(),
          jobId: job.id,
          status: "woke",
          sessionId: job.sessionId,
          turnId,
          channel: "schedule",
        });
        ctx.log.info("scheduler wake", { jobId: job.id, sessionId: job.sessionId, turnId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.warn("scheduler wake failed", { jobId: job.id, message });
        appendWake(ctx.paths.data, { ts: now.toISOString(), jobId: job.id, status: "error", error: message });
      }
    }

    async function tick(): Promise<void> {
      if (pumping) return;
      pumping = true;
      try {
        const now = new Date();
        for (const job of store.list()) {
          if (!job.enabled) continue;
          if (job.kind === "at") {
            if (!job.at) continue;
            const at = new Date(job.at).getTime();
            if (Number.isNaN(at) || at > now.getTime()) continue;
            await fire(job, now);
            continue;
          }
          if (!job.cron) continue;
          try {
            if (!cronDue(job.cron, job.lastRunAt, now)) continue;
          } catch (err) {
            ctx.log.warn("scheduler bad cron", { jobId: job.id, err: err instanceof Error ? err.message : err });
            continue;
          }
          await fire(job, now);
        }
      } finally {
        pumping = false;
      }
    }

    ctx.tool({
      name: "schedule.create",
      description:
        "Поставь напоминание в этот чат. Это и есть таймер: разовая задача и повтор. «Через N секунд/минут» — delaySeconds (38 = через 38 секунд). Точное время — at, ISO с поясом, например 2026-10-27T15:00:00+03:00. Повтор — cron из 5 полей, локальные минуты: «0 9 * * 1-5» по будням в 09:00, «*/5 * * * *» каждые 5 минут. Секунды в cron нет. sessionId не передавай, если будить этот же чат. text — что сделать в момент срабатывания, дословно, например «Напиши одно слово: привет».",
      input: createInput,
      sideEffects: "write",
      async run(input, call) {
        if (input.cron) {
          try {
            parseCron(input.cron);
          } catch (err) {
            throw new ToolError("bad_cron", err instanceof Error ? err.message : String(err), {
              hint: 'Example: "*/5 * * * *" every 5 minutes, "0 9 * * 1-5" weekdays 09:00 local.',
            });
          }
        }
        let atIso: string | undefined;
        if (input.delaySeconds != null) atIso = new Date(Date.now() + input.delaySeconds * 1000).toISOString();
        else if (input.at) {
          const t = new Date(input.at);
          if (Number.isNaN(t.getTime())) {
            throw new ToolError("bad_at", "at must be a valid ISO-8601 timestamp", { hint: "Example: 2026-10-27T15:00:00+03:00. For 'in 38 seconds' use delaySeconds: 38." });
          }
          atIso = t.toISOString();
        }
        const sessionId = input.sessionId ?? call.sessionId;
        const session = await ctx.agent.getSession(sessionId);
        if (!session) {
          throw new ToolError("not_found", `session ${sessionId} not found`, { hint: "Omit sessionId to wake this chat." });
        }
        const now = new Date();
        const kind = input.cron ? "cron" : "at";
        const job: ScheduleJob = {
          id: newJobId(),
          name: input.name?.trim() || (kind === "cron" ? `cron ${input.cron}` : `at ${atIso}`),
          kind,
          ...(input.cron ? { cron: input.cron.trim() } : {}),
          ...(atIso ? { at: atIso } : {}),
          sessionId,
          text: input.text,
          enabled: true,
          createdAt: now.toISOString(),
          lastRunAt: null,
          nextRunAt: null,
          runCount: 0,
        };
        job.nextRunAt = computeNext(job, now);
        store.upsert(job);
        return { content: JSON.stringify(publicJob(job), null, 2) };
      },
    });

    ctx.tool({
      name: "schedule.list",
      description: "List durable schedule jobs (cron / fire-at), including last and next run.",
      input: z.object({}),
      sideEffects: "read",
      idempotent: true,
      async run() {
        return { content: JSON.stringify({ jobs: store.list().map(publicJob) }, null, 2) };
      },
    });

    ctx.tool({
      name: "schedule.cancel",
      description: "Disable and remove a schedule job by id.",
      input: z.object({ id: z.string().min(1).max(80) }),
      sideEffects: "write",
      idempotent: true,
      async run({ id }) {
        const existing = store.get(id);
        if (!existing) throw new ToolError("not_found", `job ${id} not found`, { hint: "Use schedule.list." });
        store.remove(id);
        return { content: JSON.stringify({ cancelled: id, name: existing.name }) };
      },
    });

    ctx.http({
      method: "GET",
      path: "/jobs",
      handler() {
        return Response.json({ jobs: store.list().map(publicJob), tickMs });
      },
    });

    ctx.http({
      method: "GET",
      path: "/occurrences",
      handler(req) {
        const url = new URL(req.url);
        const from = new Date(url.searchParams.get("from") ?? "");
        const to = new Date(url.searchParams.get("to") ?? "");
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
          return Response.json({ error: { code: "bad_request", message: "from and to must be dates" } }, { status: 400 });
        }
        const items: { jobId: string; name: string; at: string; kind: string }[] = [];
        for (const job of store.list()) {
          if (!job.enabled) continue;
          if (job.kind === "at" && job.at) {
            const t = new Date(job.at);
            if (t >= from && t <= to) items.push({ jobId: job.id, name: job.name, at: t.toISOString(), kind: "at" });
          } else if (job.kind === "cron" && job.cron) {
            try {
              for (const hit of cronBetween(job.cron, from, to)) items.push({ jobId: job.id, name: job.name, at: hit.toISOString(), kind: "cron" });
            } catch {
              /* skip a cron the calendar cannot expand */
            }
          }
        }
        items.sort((a, b) => (a.at < b.at ? -1 : 1));
        return Response.json({ items });
      },
    });

    ctx.http({
      method: "GET",
      path: "/wakes",
      handler() {
        const file = join(ctx.paths.data, "wakes.jsonl");
        if (!existsSync(file)) return Response.json({ wakes: [] });
        const lines = readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .slice(-100)
          .map((l) => JSON.parse(l) as unknown);
        return Response.json({ wakes: lines });
      },
    });

    for (const job of store.list()) {
      if (!job.enabled) continue;
      const next = computeNext(job);
      if (job.nextRunAt !== next) {
        job.nextRunAt = next;
        store.upsert(job);
      }
    }

    void tick();
    timer = setInterval(() => {
      void tick();
    }, tickMs);
    timer.unref?.();
    stopTimer = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
  },
  dispose() {
    stopTimer?.();
    stopTimer = undefined;
  },
});
