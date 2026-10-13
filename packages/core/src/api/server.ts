import { timingSafeEqual } from "node:crypto";
import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { PROTOCOL_VERSION, type Actor } from "@sinty/sdk";
import { AgentError } from "../agent.js";
import type { BusMessage } from "../bus.js";
import type { Sinty } from "../sinty.js";

export function createApp(sinty: Sinty): Hono {
  const app = new Hono();
  const token = sinty.secrets.resolve(sinty.config.server.token);

  app.onError((err, c) => {
    if (err instanceof AgentError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    return c.json({ error: { code: "internal", message: err.message } }, 500);
  });

  app.get("/v1/health", (c) => c.json({ ok: true, protocol: PROTOCOL_VERSION }));

  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/health") return next();
    const header = c.req.header("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : (c.req.query("token") ?? "");
    if (!token || !safeEqual(given, token)) return c.json({ error: { code: "unauthorized", message: "missing or invalid bearer token" } }, 401);
    return next();
  });

  app.get("/v1/agent", (c) =>
    c.json({
      name: sinty.config.agent.name,
      protocol: PROTOCOL_VERSION,
      models: { default: sinty.config.models.default ?? null, fallback: sinty.config.models.fallback },
      tools: sinty.agent.toolSchemas().map((t) => ({ name: t.name, description: t.description })),
      plugins: [...sinty.host.plugins.values()].map((p) => ({ name: p.name, version: p.loaded.manifest.version, disabled: p.disabled })),
    }),
  );

  app.post("/v1/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; projectId?: string; metadata?: Record<string, unknown> };
    return c.json(sinty.agent.createSession(body), 201);
  });

  app.get("/v1/sessions", (c) => c.json({ sessions: sinty.journal.listSessions(Number(c.req.query("limit") ?? 100)) }));

  app.get("/v1/sessions/:id", (c) => {
    const s = sinty.journal.getSession(c.req.param("id"));
    if (!s) throw new AgentError("not_found", "session not found", 404);
    return c.json({ ...s, activeTurn: sinty.journal.activeTurn(s.id) ?? null });
  });

  app.post("/v1/sessions/:id/messages", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: string; channel?: string };
    if (!body.text?.trim()) throw new AgentError("bad_request", "text is required");
    const r = sinty.agent.send(c.req.param("id"), body.text, { idempotencyKey: c.req.header("idempotency-key"), channel: body.channel });
    return c.json(r, 202);
  });

  app.get("/v1/sessions/:id/events", (c) => {
    const after = Number(c.req.query("after") ?? 0);
    return c.json({ events: sinty.journal.events(c.req.param("id"), { afterSeq: after, limit: Number(c.req.query("limit") ?? 1000) }) });
  });

  app.get("/v1/sessions/:id/stream", (c) => sse(c, sinty, c.req.param("id")));

  app.post("/v1/sessions/:id/approvals/:callId", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { decision?: string; note?: string };
    if (body.decision !== "approve" && body.decision !== "deny") throw new AgentError("bad_request", 'decision must be "approve" or "deny"');
    const by: Actor = { kind: "human", id: "api" };
    sinty.agent.decide(c.req.param("id"), c.req.param("callId"), body.decision, by, body.note);
    return c.json({ ok: true });
  });

  app.post("/v1/sessions/:id/interrupt", async (c) => c.json({ interrupted: await sinty.agent.interrupt(c.req.param("id")) }));

  return app;
}

function sse(c: Context, sinty: Sinty, sessionId: string): Response {
  if (!sinty.journal.getSession(sessionId)) throw new AgentError("not_found", "session not found", 404);
  const after = Number(c.req.query("after") ?? c.req.header("last-event-id") ?? 0);
  return streamSSE(c, async (stream) => {
    const queue: BusMessage[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = sinty.bus.subscribe((m) => {
      if (m.event.sessionId !== sessionId) return;
      queue.push(m);
      wake?.();
    });
    stream.onAbort(() => {
      unsubscribe();
      wake?.();
    });
    let lastSeq = after;
    for (const e of sinty.journal.events(sessionId, { afterSeq: after })) {
      await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
      lastSeq = e.seq;
    }
    const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "{}" }), 15_000);
    try {
      while (!stream.aborted) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        wake = undefined;
        for (const m of queue.splice(0)) {
          if (m.kind === "journal") {
            if (m.event.seq <= lastSeq) continue;
            lastSeq = m.event.seq;
            await stream.writeSSE({ id: String(m.event.seq), event: m.event.type, data: JSON.stringify(m.event) });
          } else {
            await stream.writeSSE({ event: m.event.type, data: JSON.stringify(m.event) });
          }
        }
      }
    } finally {
      clearInterval(ping);
      unsubscribe();
    }
  });
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function startServer(sinty: Sinty, opts: { host?: string; port?: number } = {}): Promise<{ server: ServerType; url: string }> {
  const app = createApp(sinty);
  const hostname = opts.host ?? sinty.config.server.host;
  const port = opts.port ?? sinty.config.server.port;
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, hostname, port }, (info) => resolve({ server, url: `http://${hostname}:${info.port}` }));
  });
}
