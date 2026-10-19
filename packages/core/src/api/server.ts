import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { PROTOCOL_VERSION, type Actor, type BlobRef, type EventType, type LiveEvent } from "@sinty/sdk";
import { AgentError } from "../agent.js";
import { saveBlob } from "../blobs.js";
import { liveEvents, sessionInfo } from "../plugin-bridge.js";
import type { Sinty } from "../sinty.js";
import { DEFAULT_COMPRESS_PROMPT, DEFAULT_FACTS_PROMPT, loadConfig, saveModelCatalog, saveSettings } from "../config.js";
import { loadRegistry } from "../registry.js";
import { deleteAgent, deleteProject, listAgents, listProjects, saveAgent, saveProject, setSharedPlugins, sharedPlugins, type AgentRecord } from "../roster.js";
import { listSkills } from "../skills.js";
import { matchRoute, serveStatic } from "./static.js";

async function discoverModels(protocol: string, baseUrl: string, apiKey: string): Promise<{ id: string }[]> {
  if (protocol === "anthropic") {
    const root = (baseUrl || "https://api.anthropic.com").replace(/\/v1$/, "");
    const res = await fetch(`${root}/v1/models?limit=100`, {
      headers: { "anthropic-version": "2023-06-01", ...(apiKey ? { "x-api-key": apiKey } : {}) },
    });
    if (!res.ok) throw new AgentError("bad_gateway", `провайдер ответил ${res.status}`, 502);
    const body = (await res.json()) as { data?: { id?: string }[] };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id)).map((id) => ({ id }));
  }
  const root = baseUrl || "https://api.openai.com/v1";
  const res = await fetch(`${root}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
  if (!res.ok) throw new AgentError("bad_gateway", `провайдер ответил ${res.status}`, 502);
  const body = (await res.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id)).sort().map((id) => ({ id }));
}

/** Events that the overview stream (`/v1/stream`) carries for all sessions. */
const OVERVIEW: ReadonlySet<EventType> = new Set<EventType>([
  "session.created",
  "session.updated",
  "agent.state",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "turn.blocked",
  "turn.resumed",
  "message.user",
  "message.agent",
  "tool.call.approval_requested",
  "tool.call.approved",
  "tool.call.denied",
  "supervisor.notice",
  "supervisor.escalated",
  "supervisor.incident_resolved",
  "plugin.patch.proposed",
  "plugin.patch.tested",
  "plugin.patch.applied",
  "plugin.patch.rolled_back",
]);

const SUPERVISOR_EVENTS: EventType[] = ["supervisor.notice", "supervisor.escalated", "supervisor.incident_resolved"];

export function createApp(sinty: Sinty): Hono {
  const app = new Hono();
  const token = sinty.secrets.resolve(sinty.config.server.token);
  const authorized = (c: Context): boolean => {
    const header = c.req.header("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : (c.req.query("token") ?? "");
    return Boolean(token) && safeEqual(given, token!);
  };
  const unauthorized = (c: Context): Response => c.json({ error: { code: "unauthorized", message: "missing or invalid bearer token" } }, 401);

  app.onError((err, c) => {
    if (err instanceof AgentError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    return c.json({ error: { code: "internal", message: err.message } }, 500);
  });

  app.get("/v1/health", (c) => c.json({ ok: true, protocol: PROTOCOL_VERSION }));

  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/health") return next();
    if (!authorized(c)) return unauthorized(c);
    return next();
  });

  app.get("/v1/registry", (c) => {
    const enabled = new Set(sinty.config.plugins.enabled);
    return c.json({
      protocol: PROTOCOL_VERSION,
      plugins: loadRegistry(sinty.paths).map((p) => ({ ...p, enabled: enabled.has(p.name) })),
    });
  });

  app.get("/v1/settings", (c) => {
    const enabled = new Set(sinty.config.plugins.enabled);
    const catalog = loadRegistry(sinty.paths);
    const known = new Set(catalog.map((p) => p.name));
    const extra = sinty.config.plugins.enabled.filter((name) => !known.has(name)).map((name) => ({ name, version: "", description: "", kinds: [] as string[], enabled: true }));
    return c.json({
      model: sinty.config.models.default ?? "",
      fallback: sinty.config.models.fallback,
      providers: Object.keys(sinty.config.providers),
      agentsMd: existsSync(sinty.paths.agents) ? readFileSync(sinty.paths.agents, "utf8") : "",
      serviceModel: sinty.config.service.model,
      compress: sinty.config.service.compress || DEFAULT_COMPRESS_PROMPT,
      facts: sinty.config.service.facts || DEFAULT_FACTS_PROMPT,
      stallSeconds: sinty.config.supervisor.stallSeconds,
      plugins: [...catalog.map((p) => ({ ...p, enabled: enabled.has(p.name) })), ...extra],
    });
  });

  app.put("/v1/settings", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { model?: unknown; fallback?: unknown; enabled?: unknown; agentsMd?: unknown; serviceModel?: unknown; compress?: unknown; facts?: unknown; stallSeconds?: unknown } | null;
    if (!body || typeof body.model !== "string" || !Array.isArray(body.enabled)) {
      throw new AgentError("bad_request", "model and enabled are required");
    }
    const fallback = Array.isArray(body.fallback) ? body.fallback.filter((x): x is string => typeof x === "string") : [];
    const enabled = body.enabled.filter((x): x is string => typeof x === "string");
    try {
      saveSettings(
        sinty.paths,
        {
          model: body.model,
          fallback,
          enabled,
          ...(typeof body.agentsMd === "string" ? { agentsMd: body.agentsMd } : {}),
          ...(typeof body.serviceModel === "string" ? { serviceModel: body.serviceModel } : {}),
          ...(typeof body.compress === "string" ? { compress: body.compress } : {}),
          ...(typeof body.facts === "string" ? { facts: body.facts } : {}),
          ...(typeof body.stallSeconds === "number" ? { stallSeconds: body.stallSeconds } : {}),
        },
        sinty.config.providers,
      );
    } catch (e) {
      throw new AgentError("bad_request", e instanceof Error ? e.message : String(e));
    }
    const next = loadConfig(sinty.paths);
    sinty.config.models.default = next.models.default;
    sinty.config.models.fallback = next.models.fallback;
    sinty.config.plugins.enabled = next.plugins.enabled;
    sinty.config.service = next.service;
    sinty.config.supervisor.stallSeconds = next.supervisor.stallSeconds;
    return c.json({ ok: true, restart: true, model: sinty.config.models.default ?? "", enabled: sinty.config.plugins.enabled });
  });

  app.get("/v1/agent", (c) =>
    c.json({
      name: sinty.config.agent.name,
      protocol: PROTOCOL_VERSION,
      models: { default: sinty.config.models.default ?? null, fallback: sinty.config.models.fallback },
      tools: sinty.agent.toolSchemas().map((t) => ({ name: t.name, description: t.description })),
      plugins: [...sinty.host.plugins.values()].map((p) => ({ name: p.name, version: p.loaded.manifest.version, disabled: p.disabled })),
      supervisor: Boolean(sinty.supervisor),
    }),
  );

  app.get("/v1/plugins", (c) =>
    c.json({
      plugins: [...sinty.host.plugins.values()].map((p) => ({
        name: p.name,
        version: p.loaded.manifest.version,
        description: p.loaded.manifest.description,
        kinds: p.loaded.manifest.kinds,
        location: p.loaded.bundled ? "bundled" : "home",
        editable: p.loaded.manifest.editable !== false,
        disabled: p.disabled,
        tools: p.tools.map((t) => t.name),
        routes: p.routes.map((r) => ({ method: r.method, path: `/p/${p.name}${r.path}`, public: r.public })),
        runtime: p.loaded.manifest.runtime,
        ui: p.loaded.manifest.ui && p.loaded.manifest.editable === false ? `/ui/${p.name}/` : null,
        permissions: p.loaded.manifest.permissions,
        forAll: sharedPlugins(sinty.paths) === null || sharedPlugins(sinty.paths)!.includes(p.name),
      })),
    }),
  );

  app.post("/v1/models/discover", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { id?: string; baseUrl?: string; protocol?: string; apiKey?: string };
    const id = (body.id ?? "").trim();
    const known = sinty.config.providers[id];
    if (!known && !body.baseUrl) throw new AgentError("bad_request", "провайдер не найден", 400);
    const protocol = body.protocol || known?.protocol || "openai-compat";
    const baseUrl = (body.baseUrl || known?.baseUrl || "").trim().replace(/\/+$/, "");
    const typed = (body.apiKey ?? "").trim();
    const apiKey = typed || (known?.apiKey ? sinty.secrets.resolve(known.apiKey) ?? "" : "");
    const models = await discoverModels(protocol, baseUrl, apiKey);
    return c.json({ models });
  });

  app.get("/v1/models", (c) => {
    const catalog = sinty.config.models.catalog.length
      ? sinty.config.models.catalog
      : sinty.config.models.default
        ? [{ route: sinty.config.models.default, enabled: true }]
        : [];
    return c.json({
      models: catalog,
      providers: Object.entries(sinty.config.providers).map(([id, p]) => ({
        id,
        protocol: p.protocol,
        baseUrl: p.baseUrl ?? "",
        hasKey: Boolean(p.apiKey && sinty.secrets.resolve(p.apiKey)),
      })),
    });
  });

  app.put("/v1/models", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      models?: { route?: string; enabled?: boolean }[];
      providers?: { id?: string; baseUrl?: string; apiKey?: string; protocol?: string; remove?: boolean }[];
    };
    const models = (body.models ?? []).filter((m): m is { route: string; enabled: boolean } => typeof m.route === "string" && typeof m.enabled === "boolean");
    const providers = (body.providers ?? []).filter((p): p is { id: string; baseUrl?: string; apiKey?: string; protocol?: string; remove?: boolean } => typeof p.id === "string");
    try {
      saveModelCatalog(sinty.paths, models, providers, sinty.config.providers);
    } catch (e) {
      throw new AgentError("bad_request", e instanceof Error ? e.message : String(e));
    }
    for (const p of providers) {
      if (p.apiKey && p.apiKey.trim()) sinty.secrets.set(p.id.trim(), p.apiKey.trim());
    }
    const next = loadConfig(sinty.paths);
    sinty.config.providers = next.providers;
    sinty.config.models = next.models;
    return c.json({ ok: true });
  });

  app.get("/v1/roster/skills", (c) => c.json({ skills: listSkills(sinty.paths.skills).map((s) => ({ name: s.name, description: s.description })) }));

  app.get("/v1/roster/agents", (c) => c.json({ agents: listAgents(sinty.paths) }));

  app.post("/v1/roster/agents", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<AgentRecord>;
    try {
      return c.json(saveAgent(sinty.paths, { ...body, name: body.name ?? "" }), 201);
    } catch (e) {
      throw new AgentError("bad_request", e instanceof Error ? e.message : String(e));
    }
  });

  app.put("/v1/roster/agents/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<AgentRecord>;
    try {
      return c.json(saveAgent(sinty.paths, { ...body, id: c.req.param("id"), name: body.name ?? "" }));
    } catch (e) {
      throw new AgentError("bad_request", e instanceof Error ? e.message : String(e));
    }
  });

  app.delete("/v1/roster/agents/:id", (c) => {
    deleteAgent(sinty.paths, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/v1/roster/projects", (c) => c.json({ projects: listProjects(sinty.paths) }));

  app.post("/v1/roster/projects", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; leadId?: string; agentIds?: string[] };
    try {
      return c.json(saveProject(sinty.paths, { name: body.name ?? "", ...(body.leadId !== undefined ? { leadId: body.leadId } : {}), ...(body.agentIds ? { agentIds: body.agentIds } : {}) }), 201);
    } catch (e) {
      throw new AgentError("bad_request", e instanceof Error ? e.message : String(e));
    }
  });

  app.put("/v1/roster/projects/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; leadId?: string; agentIds?: string[] };
    try {
      return c.json(saveProject(sinty.paths, { id: c.req.param("id"), name: body.name ?? "", ...(body.leadId !== undefined ? { leadId: body.leadId } : {}), ...(body.agentIds ? { agentIds: body.agentIds } : {}) }));
    } catch (e) {
      throw new AgentError("bad_request", e instanceof Error ? e.message : String(e));
    }
  });

  app.delete("/v1/roster/projects/:id", (c) => {
    deleteProject(sinty.paths, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.put("/v1/plugins/shared", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { names?: string[] };
    return c.json({ names: setSharedPlugins(sinty.paths, body.names ?? []) });
  });

  app.post("/v1/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; projectId?: string; metadata?: Record<string, unknown> };
    return c.json(sessionInfo(sinty.journal, sinty.agent.createSession(body)), 201);
  });

  app.get("/v1/sessions", (c) => c.json({ sessions: sinty.journal.listSessions(Number(c.req.query("limit") ?? 100)).map((s) => sessionInfo(sinty.journal, s)) }));

  app.delete("/v1/sessions/:id", (c) => {
    if (!sinty.journal.deleteSession(c.req.param("id"))) throw new AgentError("not_found", "session not found", 404);
    return c.json({ ok: true });
  });

  app.patch("/v1/sessions/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; projectId?: string | null };
    const patch: { title?: string; projectId?: string | null } = {};
    if (typeof body.title === "string") patch.title = body.title.trim();
    if (body.projectId === null || typeof body.projectId === "string") patch.projectId = body.projectId;
    const s = sinty.journal.patchSession(c.req.param("id"), patch);
    if (!s) throw new AgentError("not_found", "session not found", 404);
    return c.json(sessionInfo(sinty.journal, s));
  });

  app.get("/v1/sessions/:id", (c) => {
    const s = sinty.journal.getSession(c.req.param("id"));
    if (!s) throw new AgentError("not_found", "session not found", 404);
    return c.json({ ...sessionInfo(sinty.journal, s), pending: sinty.agent.pending(s.id) });
  });

  app.post("/v1/blobs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; mime?: string; dataBase64?: string };
    if (!body.dataBase64) throw new AgentError("bad_request", "dataBase64 is required");
    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.dataBase64, "base64");
    } catch {
      throw new AgentError("bad_request", "dataBase64 is not valid");
    }
    if (!bytes.length) throw new AgentError("bad_request", "file is empty");
    try {
      return c.json(saveBlob(sinty.paths.data, { bytes, mime: body.mime || "application/octet-stream", ...(body.name ? { name: body.name } : {}) }), 201);
    } catch (e) {
      throw new AgentError("bad_request", e instanceof Error ? e.message : String(e));
    }
  });

  app.post("/v1/sessions/:id/messages", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: string; channel?: string; attachments?: BlobRef[]; agentId?: string };
    const text = body.text?.trim() || (body.attachments?.length ? "Смотри вложения." : "");
    if (!text) throw new AgentError("bad_request", "text is required");
    const r = sinty.agent.send(c.req.param("id"), text, { idempotencyKey: c.req.header("idempotency-key"), channel: body.channel, attachments: body.attachments, agentId: body.agentId });
    return c.json(r, 202);
  });

  app.get("/v1/sessions/:id/events", (c) => {
    const after = Number(c.req.query("after") ?? 0);
    return c.json({ events: sinty.journal.events(c.req.param("id"), { afterSeq: after, limit: Number(c.req.query("limit") ?? 1000) }) });
  });

  app.get("/v1/sessions/:id/stream", (c) => {
    const sessionId = c.req.param("id");
    const after = Number(c.req.query("after") ?? c.req.header("last-event-id") ?? 0);
    return sse(c, (push) => liveEvents(sinty.journal, sinty.bus, sessionId, after, push));
  });

  app.get("/v1/sessions/:id/pending", (c) => c.json({ pending: sinty.agent.pending(c.req.param("id")) }));

  app.post("/v1/sessions/:id/approvals/:callId", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { decision?: string; note?: string };
    if (body.decision !== "approve" && body.decision !== "deny") throw new AgentError("bad_request", 'decision must be "approve" or "deny"');
    const by: Actor = { kind: "human", id: "api" };
    sinty.agent.decide(c.req.param("id"), c.req.param("callId"), body.decision, by, body.note);
    return c.json({ ok: true });
  });

  app.post("/v1/sessions/:id/interrupt", async (c) => c.json({ interrupted: await sinty.agent.interrupt(c.req.param("id")) }));

  /** Everything that waits for a human, across sessions. */
  app.get("/v1/pending", (c) =>
    c.json({
      pending: sinty.journal
        .activeTurns()
        .filter((t) => t.status === "blocked")
        .map((t) => sinty.agent.pending(t.sessionId))
        .filter(Boolean),
    }),
  );

  app.get("/v1/supervisor", (c) =>
    c.json({
      enabled: Boolean(sinty.supervisor),
      events: sinty.journal.recentEvents(SUPERVISOR_EVENTS, Number(c.req.query("limit") ?? 100)),
      incidents: sinty.journal.incidents(200).reverse(),
      patches: sinty.journal.listPatches(50).map(({ files, ...p }) => ({ ...p, files: files.map((f) => f.path) })),
    }),
  );

  /** Lifecycle events of all sessions, live only; for lists, boards and badges. */
  app.get("/v1/stream", (c) =>
    sse(c, (push) =>
      sinty.bus.subscribe((m) => {
        if (m.kind === "journal" && OVERVIEW.has(m.event.type)) push(m.event);
      }),
    ),
  );

  // ---- plugin HTTP routes ----

  const pluginRoute = async (c: Context): Promise<Response> => {
    const name = c.req.param("plugin") ?? "";
    const proc = sinty.host.plugins.get(name);
    if (!proc || proc.disabled || proc.staticOnly) return c.json({ error: { code: "not_found", message: `no plugin ${name} with HTTP routes` } }, 404);
    const prefix = `/p/${name}`;
    const rel = c.req.path.slice(prefix.length) || "/";
    const method = c.req.method.toUpperCase();
    let found: { index: number; params: Record<string, string>; public: boolean } | undefined;
    for (const [index, r] of proc.routes.entries()) {
      if (r.method !== "*" && r.method !== method && !(method === "HEAD" && r.method === "GET")) continue;
      const params = matchRoute(r.path, rel);
      if (params) {
        found = { index, params, public: r.public };
        break;
      }
    }
    if (!found) return c.json({ error: { code: "not_found", message: `${method} ${rel} is not a route of ${name}` } }, 404);
    if (!found.public && !authorized(c)) return unauthorized(c);
    const url = new URL(c.req.url);
    url.searchParams.delete("token");
    const search = url.searchParams.toString();
    return proc.handleHttp(found.index, found.params, c.req.raw, rel + (search ? `?${search}` : ""));
  };
  app.all("/p/:plugin", pluginRoute);
  app.all("/p/:plugin/*", pluginRoute);

  // ---- static UI from non-editable plugins ----

  const uiRoot = (name: string): string | undefined => {
    const p = sinty.host.plugins.get(name);
    const ui = p?.loaded.manifest.ui;
    if (!p || !ui || p.loaded.manifest.editable !== false) return undefined;
    return join(p.loaded.dir, ui.static);
  };
  app.get("/ui/:plugin/*", (c) => {
    const name = c.req.param("plugin");
    const root = uiRoot(name);
    if (!root) return c.text("not found", 404);
    return serveStatic(root, c.req.path.slice(`/ui/${name}/`.length));
  });
  app.get("/ui/:plugin", (c) => c.redirect(`/ui/${c.req.param("plugin")}/`));
  app.get("/", (c) => (uiRoot(sinty.config.server.ui) ? c.redirect(`/ui/${sinty.config.server.ui}/`) : c.json({ name: "sinty", protocol: PROTOCOL_VERSION, api: "/v1" })));

  return app;
}

function sse(c: Context, subscribe: (push: (e: LiveEvent) => void) => () => void): Response {
  const queue: LiveEvent[] = [];
  let wake: (() => void) | undefined;
  const unsubscribe = subscribe((e) => {
    queue.push(e);
    wake?.();
  });
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => {
      unsubscribe();
      wake?.();
    });
    const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "{}" }), 15_000);
    try {
      while (!stream.aborted) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        wake = undefined;
        for (const e of queue.splice(0)) {
          await stream.writeSSE({ ...("seq" in e ? { id: String(e.seq) } : {}), event: e.type, data: JSON.stringify(e) });
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
