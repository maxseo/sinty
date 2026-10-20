import { definePlugin } from "@sinty/sdk";
import { TAB_CSP, TAB_HTML } from "./page.js";
import { SnapshotStore, summarize } from "./store.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });

export default definePlugin({
  name: "context-inspector",
  setup(ctx) {
    const keep = Math.max(1, Math.min(Number(ctx.config.keep) || 100, 2000));
    const maxBytes = Math.max(1, Math.min(Number(ctx.config.maxMb) || 64, 1024)) * 1024 * 1024;
    const store = new SnapshotStore(keep, maxBytes);

    ctx.onContextSnapshot((snap) => store.add(snap));
    // Real token counts (cache hits and misses) arrive after the step's model call, keyed by its stepId.
    ctx.on("usage.recorded", (e) => {
      if (e.stepId) store.addUsage(e.stepId, e.data);
    });

    // The page itself is public and static: the iframe cannot send the API token. It holds no data.
    ctx.http({
      method: "GET",
      path: "/tab",
      public: true,
      handler: () =>
        new Response(TAB_HTML, {
          headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": TAB_CSP, "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" },
        }),
    });
    // Data routes need the bearer token; the Web UI's bridge adds it.
    ctx.http({ method: "GET", path: "/sessions", handler: () => json({ sessions: store.sessions(), size: store.size, keep }) });
    ctx.http({
      method: "GET",
      path: "/snapshots",
      handler: (req) => json({ snapshots: store.list(new URL(req.url, "http://x").searchParams.get("session") ?? undefined) }),
    });
    ctx.http({
      method: "GET",
      path: "/snapshots/:id",
      handler: (_req, { params }) => {
        const snap = store.get(params.id ?? "");
        const usage = snap ? store.usageOf(snap.stepId) : undefined;
        return snap ? json({ ...snap, ...(usage ? { usage } : {}) }) : json({ error: { code: "not_found", message: "no such snapshot (only the newest are kept, in memory)" } }, 404);
      },
    });
    ctx.http({
      method: "GET",
      path: "/summary/:id",
      handler: (_req, { params }) => {
        const snap = store.get(params.id ?? "");
        return snap ? json(summarize(snap, store.usageOf(snap.stepId))) : json({ error: { code: "not_found", message: "no such snapshot" } }, 404);
      },
    });
  },
});
