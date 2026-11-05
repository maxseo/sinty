import { join } from "node:path";
import { definePlugin, z, type EventType, type SintyEvent } from "@sinty/sdk";
import { clampOffset, facetsOf, pageOf, seriesOf, summarize, tasksOf } from "./query.js";
import { TAB_CSP, tabHtml } from "./page.js";
import { openUsage, type UsageStore } from "./store.js";
import type { UsageFilter } from "./types.js";

const TYPES: EventType[] = ["session.created", "session.updated", "message.agent", "model.request", "model.response", "models.called", "usage.recorded"];

const querySchema = z.object({
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  model: z.string().max(200).optional(),
  provider: z.string().max(200).optional(),
  agent: z.string().max(200).optional(),
  session: z.string().max(100).optional(),
  tz: z.string().regex(/^-?\d{1,4}$/).optional(),
  limit: z.string().regex(/^\d{1,4}$/).optional(),
  offset: z.string().regex(/^\d{1,7}$/).optional(),
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function fail(message: string, status = 400): Response {
  return json({ error: { code: status === 400 ? "bad_request" : "usage_error", message } }, status);
}

function dateOrError(value: string | undefined): { ok: true; value?: string } | { ok: false; message: string } {
  if (!value) return { ok: true };
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return { ok: false, message: "дата должна быть в формате ISO" };
  return { ok: true, value: new Date(t).toISOString() };
}

function readQuery(req: Request): { filter: UsageFilter; tz: number; limit: number; offset: number } | { error: string } {
  const url = new URL(req.url);
  const raw: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    const trimmed = value.trim();
    if (trimmed) raw[key] = trimmed;
  }
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) return { error: "неверные параметры" };
  const from = dateOrError(parsed.data.from);
  const to = dateOrError(parsed.data.to);
  if (!from.ok) return { error: from.message };
  if (!to.ok) return { error: to.message };
  const filter: UsageFilter = {};
  if (from.value) filter.from = from.value;
  if (to.value) filter.to = to.value;
  if (parsed.data.model) filter.model = parsed.data.model;
  if (parsed.data.provider) filter.provider = parsed.data.provider;
  if (parsed.data.agent) filter.agent = parsed.data.agent;
  if (parsed.data.session) filter.session = parsed.data.session;
  const limit = Math.min(200, Math.max(1, Number(parsed.data.limit ?? 40)));
  const offset = Math.max(0, Number(parsed.data.offset ?? 0));
  return { filter, tz: clampOffset(Number(parsed.data.tz ?? 0)), limit, offset };
}

let closeDb = (): void => {};

export default definePlugin({
  name: "usage",
  setup(ctx) {
    const store: UsageStore = openUsage(join(ctx.paths.data, "usage.db"));
    closeDb = () => store.close();
    let backfill: "running" | "done" | "error" = "running";
    let backfillError = "";
    let sessions = 0;

    const onEvent = (event: SintyEvent): void => {
      try {
        store.ingest(event.sessionId, event);
      } catch (e) {
        ctx.log.warn("usage ingest failed", e instanceof Error ? e.message : e);
      }
    };
    for (const type of TYPES) ctx.on(type, onEvent);

    function retainDays(): number {
      const n = Number(ctx.config.retainDays);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return Math.min(3650, Math.floor(n));
    }

    setTimeout(() => {
      void (async () => {
        try {
          const list = await ctx.agent.listSessions({ limit: 500 });
          for (const s of list) {
            const taskId = s.metadata.taskId;
            const hint = { title: s.title ?? "", task: typeof taskId === "string" && taskId.length > 0 };
            let after = store.cursor(s.id);
            for (;;) {
              const events = await ctx.agent.events(s.id, { afterSeq: after, types: TYPES, limit: 5000 });
              if (!events.length) break;
              for (const event of events) store.ingest(s.id, event, hint);
              after = events[events.length - 1]!.seq;
              store.setCursor(s.id, after);
              if (events.length < 5000) break;
            }
            sessions += 1;
          }
          store.prune(retainDays());
          backfill = "done";
        } catch (e) {
          backfill = "error";
          backfillError = e instanceof Error ? e.message : String(e);
          ctx.log.warn("usage backfill failed", backfillError);
        }
      })();
    }, 0);

    const html = (): Response =>
      new Response(tabHtml(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": TAB_CSP,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      });

    ctx.http({ method: "GET", path: "/tab", public: true, surface: "spend", handler: () => html() });

    ctx.http({
      method: "GET",
      path: "/status",
      surface: "settings",
      access: "view",
      handler: () => json({
        calls: store.count(),
        oldest: store.oldest(),
        newest: store.newest(),
        backfill,
        sessions,
        retainDays: retainDays(),
        ...(backfillError ? { error: backfillError } : {}),
      }),
    });

    const scanOf = (req: Request) => {
      const q = readQuery(req);
      if ("error" in q) return q;
      return { ...q, ...store.scan(q.filter) };
    };

    ctx.http({
      method: "GET",
      path: "/summary",
      surface: "settings",
      access: "view",
      handler: (req) => {
        const scan = scanOf(req);
        if ("error" in scan) return fail(scan.error);
        return json({ ...summarize(scan.calls), truncated: scan.truncated });
      },
    });
    ctx.http({
      method: "GET",
      path: "/series",
      surface: "settings",
      access: "view",
      handler: (req) => {
        const scan = scanOf(req);
        if ("error" in scan) return fail(scan.error);
        return json({ ...seriesOf(scan.calls, scan.filter, scan.tz), truncated: scan.truncated });
      },
    });
    ctx.http({
      method: "GET",
      path: "/tasks",
      surface: "settings",
      access: "view",
      handler: (req) => {
        const scan = scanOf(req);
        if ("error" in scan) return fail(scan.error);
        return json({ items: tasksOf(scan.calls), truncated: scan.truncated });
      },
    });
    ctx.http({
      method: "GET",
      path: "/calls",
      surface: "settings",
      access: "view",
      handler: (req) => {
        const scan = scanOf(req);
        if ("error" in scan) return fail(scan.error);
        return json({ ...pageOf(scan.calls, scan.offset, scan.limit), truncated: scan.truncated });
      },
    });
    ctx.http({
      method: "GET",
      path: "/facets",
      surface: "settings",
      access: "view",
      handler: (req) => {
        const scan = scanOf(req);
        if ("error" in scan) return fail(scan.error);
        return json({ ...facetsOf(scan.calls), truncated: scan.truncated });
      },
    });
  },
  dispose() {
    closeDb();
  },
});
