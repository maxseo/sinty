import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { scrubText } from "@sinty/supervisor";
import { PROTOCOL_VERSION, type Actor, type BlobRef, type EventType, type LiveEvent } from "@sinty/sdk";
import { AgentError } from "../agent.js";
import { saveBlob } from "../blobs.js";
import { rotateApiToken, TokenRotationError } from "../api-token.js";
import { liveEvents, sessionInfo } from "../plugin-bridge.js";
import type { Sinty } from "../sinty.js";
import { DEFAULT_COMPRESS_PROMPT, DEFAULT_FACTS_PROMPT, DEFAULT_ON_PLUGINS, loadConfig, NAMED_MODEL_ROUTES, saveModelCatalog, saveNamedRoutes, saveSettings } from "../config.js";
import { installMcpPlugin, McpInstallError, type McpInstallInput } from "../mcp-install.js";
import { installHomePlugin, PluginInstallError, type PluginInstallInput } from "../plugin-install.js";
import { discoverPlugins } from "../discover.js";
import { loadRegistry } from "../registry.js";
import { deleteAgent, deleteProject, listAgents, listProjects, saveAgent, saveProject, setSharedPlugins, sharedPlugins, type AgentRecord } from "../roster.js";
import { assignPolicy, listSections, saveSection } from "../settings-sections.js";
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
  "session.policy_grant",
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
  // Resolved on every request: after a rotation (POST /v1/auth/rotate or `sinty token rotate` next to this server)
  // only the new token is accepted, without a restart.
  const given = (c: Context): string => {
    const header = c.req.header("authorization") ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : (c.req.query("token") ?? "");
  };
  const valid = (t: string): boolean => {
    const token = sinty.secrets.resolve(sinty.config.server.token);
    return Boolean(token) && safeEqual(t, token!);
  };
  const authorized = (c: Context): boolean => valid(given(c));
  // Open event streams were authorized when they started; each one re-checks its token on every ping and right
  // after a rotation, and ends when it is no longer valid.
  const streams = new Set<() => void>();
  const guard = (c: Context) => {
    const t = given(c);
    return {
      valid: () => valid(t),
      register: (check: () => void) => {
        streams.add(check);
        return () => void streams.delete(check);
      },
    };
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

  /** New login token; the caller (already signed in with the old one) gets it once in the answer. */
  app.post("/v1/auth/rotate", (c) => {
    let next: string;
    try {
      next = rotateApiToken(sinty.secrets, sinty.config);
    } catch (e) {
      if (e instanceof TokenRotationError) return c.json({ error: { code: e.code, message: e.message, hint: e.hint } }, 409);
      throw e;
    }
    for (const check of [...streams]) check();
    c.header("cache-control", "no-store");
    return c.json({ token: next });
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
    // Registry + home (+ searchPaths) so Settings → Plugins lists opt-in-off and custom installs.
    const catalog = discoverPlugins(sinty.paths, sinty.config.plugins.searchPaths);
    const known = new Set(catalog.map((p) => p.name));
    const extra = sinty.config.plugins.enabled
      .filter((name) => !known.has(name))
      .map((name) => ({ name, version: "", description: "", kinds: [] as string[], enabled: true }));
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
    // Omit fallback → preserve models.fallback (Models tab used to send [] and wipe it).
    const fallback = Array.isArray(body.fallback) ? body.fallback.filter((x): x is string => typeof x === "string") : undefined;
    const enabled = body.enabled.filter((x): x is string => typeof x === "string");
    try {
      saveSettings(
        sinty.paths,
        {
          model: body.model,
          ...(fallback !== undefined ? { fallback } : {}),
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
    sinty.config.plugins.disabled = next.plugins.disabled;
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
        ui: p.loaded.manifest.ui?.static && p.loaded.manifest.editable === false ? `/ui/${p.name}/` : null,
        tabs: p.disabled || p.staticOnly ? [] : (p.loaded.manifest.ui?.tabs ?? []).map((t) => ({ id: t.id, title: t.title, src: `/p/${p.name}${t.path}`, placement: t.placement ?? "sidebar" })),
        inspector: p.inspector,
        permissions: p.loaded.manifest.permissions,
        // Default-on plugins replace former core tools: every agent has them unless its card excludes them.
        defaultOn: DEFAULT_ON_PLUGINS.includes(p.name),
        forAll: DEFAULT_ON_PLUGINS.includes(p.name) || sharedPlugins(sinty.paths) === null || sharedPlugins(sinty.paths)!.includes(p.name),
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
      // contextWindow: { tokens, source } as compaction sees it for that route (see context-window.ts).
      models: catalog.map((m) => ({ ...m, contextWindow: sinty.windows.resolve(m.route) })),
      providers: Object.entries(sinty.config.providers).map(([id, p]) => ({
        id,
        protocol: p.protocol,
        baseUrl: p.baseUrl ?? "",
        hasKey: Boolean(p.apiKey && sinty.secrets.resolve(p.apiKey)),
      })),
      // Named routes (models.routes) + service.model for Settings → Models.
      routes: { ...(sinty.config.models.routes ?? {}) },
      namedRouteKeys: [...NAMED_MODEL_ROUTES],
      serviceModel: sinty.config.service.model ?? "",
    });
  });

  app.put("/v1/models", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      models?: { route?: string; enabled?: boolean }[];
      providers?: { id?: string; baseUrl?: string; apiKey?: string; protocol?: string; remove?: boolean }[];
      routes?: Record<string, unknown>;
      serviceModel?: unknown;
    };
    // Only route and enabled are stored: GET also sends contextWindow, which a client may hand back.
    const models = (body.models ?? []).filter((m): m is { route: string; enabled: boolean } => typeof m.route === "string" && typeof m.enabled === "boolean").map((m) => ({ route: m.route, enabled: m.enabled }));
    const providers = (body.providers ?? []).filter((p): p is { id: string; baseUrl?: string; apiKey?: string; protocol?: string; remove?: boolean } => typeof p.id === "string");
    try {
      saveModelCatalog(sinty.paths, models, providers, sinty.config.providers);
      // Reload so a provider added in this same PUT is visible to route validation.
      let mid = loadConfig(sinty.paths);
      // Deep-merge named routes: omitted keys preserved; only keys present in body.routes are written.
      if (body.routes && typeof body.routes === "object" && !Array.isArray(body.routes)) {
        const patch: Record<string, string> = {};
        for (const [k, v] of Object.entries(body.routes)) {
          if (typeof v === "string") patch[k] = v;
        }
        saveNamedRoutes(sinty.paths, patch, mid.providers);
        mid = loadConfig(sinty.paths);
      }
      if (typeof body.serviceModel === "string") {
        saveSettings(sinty.paths, { model: mid.models.default ?? "", enabled: mid.plugins.enabled, serviceModel: body.serviceModel }, mid.providers);
      }
    } catch (e) {
      throw new AgentError("bad_request", e instanceof Error ? e.message : String(e));
    }
    for (const p of providers) {
      if (p.apiKey && p.apiKey.trim()) sinty.secrets.set(p.id.trim(), p.apiKey.trim());
    }
    const next = loadConfig(sinty.paths);
    sinty.config.providers = next.providers;
    sinty.config.models = next.models;
    sinty.config.service = next.service;
    // A provider that just got a key or a new base URL may now answer its model list.
    sinty.windows.reset();
    return c.json({ ok: true, routes: next.models.routes ?? {}, serviceModel: next.service.model ?? "" });
  });


  app.post("/v1/skills/install", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { path?: unknown; zipBase64?: unknown; command?: unknown; files?: { path?: unknown; dataBase64?: unknown }[] } | null;
    if (typeof body?.command === "string") {
      const output = await runSkillCommand(body.command, sinty.paths.skills);
      return c.json(output);
    }
    const mod = await skillInstaller(sinty.paths.bundledPlugins);
    try {
      if (typeof body?.path === "string" && body.path.trim()) return c.json(mod.installSkillSource(sinty.paths.skills, body.path.trim()), 201);
      if (typeof body?.zipBase64 === "string" && body.zipBase64) return c.json(mod.installSkillZip(sinty.paths.skills, Buffer.from(body.zipBase64, "base64")), 201);
      if (Array.isArray(body?.files)) {
        const files = body.files.flatMap((f) => (typeof f.path === "string" && typeof f.dataBase64 === "string" ? [{ path: f.path, data: Buffer.from(f.dataBase64, "base64") }] : []));
        return c.json(mod.installSkillFiles(sinty.paths.skills, files), 201);
      }
    } catch (e) {
      throw new AgentError("bad_request", e instanceof Error ? e.message : String(e));
    }
    throw new AgentError("bad_request", "path, zipBase64, files or command is required");
  });

  // Kept for API clients from before plan step 7: the skills list now comes from the skills plugin (GET /p/skills/list).
  // With the plugin off there are no skills to pick, so the list is empty and says why.
  app.get("/v1/roster/skills", async (c) => {
    const proc = sinty.host.plugins.get("skills");
    const index = proc && !proc.disabled && !proc.staticOnly ? proc.routes.findIndex((r) => r.method === "GET" && r.path === "/list") : -1;
    if (!proc || index < 0) return c.json({ skills: [], disabled: true });
    return proc.handleHttp(index, {}, new Request("http://sinty.local/list", { signal: c.req.raw.signal }), "/list");
  });

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


  /** Install a custom/local (or npm) Sinty plugin into $SINTY_HOME/plugins (Settings → Plugins → Добавить). */
  app.post("/v1/plugins/install", async (c) => {
    const body = (await c.req.json().catch(() => null)) as PluginInstallInput | null;
    if (!body || typeof body !== "object") throw new AgentError("bad_request", "JSON body required");
    try {
      const result = await installHomePlugin(sinty.paths, sinty.config, sinty.host, body);
      sinty.supervisor?.setTools(sinty.agent.supervisedTools());
      return c.json(result, 201);
    } catch (e) {
      if (e instanceof PluginInstallError) {
        const status = e.code === "exists" || e.code === "bundled" ? 409 : e.code === "not_found" ? 404 : 400;
        const msg = e.hint ? `${e.message} (${e.hint})` : e.message;
        throw new AgentError(e.code, msg, status);
      }
      throw e;
    }
  });
  /** Install an external MCP server as a home plugin (same as core tool mcp.install). */
  app.post("/v1/plugins/mcp", async (c) => {
    const body = (await c.req.json().catch(() => null)) as McpInstallInput | null;
    if (!body || typeof body !== "object" || typeof body.name !== "string" || (body.runtime !== "mcp-stdio" && body.runtime !== "http")) {
      throw new AgentError("bad_request", "name and runtime (mcp-stdio|http) are required");
    }
    try {
      const result = await installMcpPlugin(sinty.paths, sinty.config, sinty.host, body);
      sinty.supervisor?.setTools(sinty.agent.supervisedTools());
      return c.json(result, 201);
    } catch (e) {
      if (e instanceof McpInstallError) {
        const status = e.code === "exists" || e.code === "bundled" ? 409 : 400;
        const msg = e.hint ? `${e.message} (${e.hint})` : e.message;
        throw new AgentError(e.code, msg, status);
      }
      throw e;
    }
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
    // Background agent.task children keep their own blocked turns; surface those approvals on the parent
    // so the human can decide without opening a hidden child chat.
    const childTurns = sinty.journal.activeTurns().filter((t) => {
      const child = sinty.journal.getSession(t.sessionId);
      return child?.metadata?.parentSessionId === s.id && (t.status === "running" || t.status === "blocked");
    });
    const childPending = childTurns
      .filter((t) => t.status === "blocked")
      .map((t) => sinty.agent.pending(t.sessionId))
      .filter((p): p is NonNullable<typeof p> => Boolean(p));
    return c.json({ ...sessionInfo(sinty.journal, s), pending: sinty.agent.pending(s.id), childPending, childBusy: childTurns.length });
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
    return sse(c, (push) => liveEvents(sinty.journal, sinty.bus, sessionId, after, push), guard(c));
  });

  app.get("/v1/sessions/:id/pending", (c) => c.json({ pending: sinty.agent.pending(c.req.param("id")) }));

  app.post("/v1/sessions/:id/approvals/:callId", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { decision?: string; note?: string; remember?: boolean };
    if (body.decision !== "approve" && body.decision !== "deny") throw new AgentError("bad_request", 'decision must be "approve" or "deny"');
    const by: Actor = { kind: "human", id: "api" };
    sinty.agent.decide(c.req.param("id"), c.req.param("callId"), body.decision, by, body.note, { remember: body.remember === true });
    return c.json({ ok: true });
  });

  /** Session-scoped auto-allow for policy `ask` (deny unchanged). Also approves current waiting asks. */
  app.post("/v1/sessions/:id/policy-grants", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { trust?: boolean; note?: string };
    if (body.trust !== true) throw new AgentError("bad_request", "trust must be true");
    const by: Actor = { kind: "human", id: "api" };
    sinty.agent.grantPolicyTrust(c.req.param("id"), by, body.note);
    return c.json({ ok: true, policyTrust: true });
  });

  app.post("/v1/sessions/:id/interrupt", async (c) => c.json({ interrupted: await sinty.agent.interrupt(c.req.param("id")) }));

  /** Stop this session and every agent.task child under it. */
  app.post("/v1/sessions/:id/stop-all", async (c) => c.json({ interrupted: await sinty.agent.stopAll(c.req.param("id")) }));

  /** Everything that waits for a human, across sessions. Child tasks include parentSessionId for the UI. */
  app.get("/v1/pending", (c) =>
    c.json({
      pending: sinty.journal
        .activeTurns()
        .filter((t) => t.status === "blocked")
        .map((t) => {
          const p = sinty.agent.pending(t.sessionId);
          if (!p) return null;
          const session = sinty.journal.getSession(t.sessionId);
          const parentSessionId =
            typeof session?.metadata?.parentSessionId === "string" ? session.metadata.parentSessionId : undefined;
          return {
            ...p,
            title: session?.title ?? null,
            ...(parentSessionId ? { parentSessionId } : {}),
          };
        })
        .filter(Boolean),
    }),
  );

  /**
   * Supervisor remarks, escalations, incidents and patches; `?sessionId=` limits them to one chat. Texts are masked
   * (typed input, password/token fields, long values) also for entries written before masking existed.
   */
  app.get("/v1/supervisor", (c) => {
    const sessionId = c.req.query("sessionId");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 500);
    const clean = (t: string): string => sinty.secrets.redact(scrubText(t));
    const events = (sessionId ? sinty.journal.events(sessionId, { types: SUPERVISOR_EVENTS }).slice(-limit).reverse() : sinty.journal.recentEvents(SUPERVISOR_EVENTS, limit)).map((e) => {
      const d = { ...(e.data as Record<string, unknown>) };
      for (const k of ["text", "reason", "fixSummary"]) if (typeof d[k] === "string") d[k] = clean(d[k]);
      return { ...e, data: d };
    });
    const ids = sessionId ? new Set(events.filter((e) => e.type === "supervisor.incident_resolved").map((e) => String((e.data as { incidentId?: unknown }).incidentId))) : undefined;
    const incidents = sinty.journal
      .incidents(500)
      .filter((i) => !ids || ids.has(i.id))
      .slice(-200)
      .reverse()
      .map((i) => ({ ...i, message: clean(i.message), fixSummary: clean(i.fixSummary) }));
    const patches = sinty.journal
      .listPatches(sessionId ? 500 : 50)
      .filter((p) => !sessionId || p.sessionId === sessionId)
      .slice(0, 50)
      .map(({ files, ...p }) => ({ ...p, reason: clean(p.reason), testOutput: clean(p.testOutput), files: files.map((f) => f.path) }));
    return c.json({ enabled: Boolean(sinty.supervisor), ...(sessionId ? { sessionId } : {}), events, incidents, patches });
  });

  // ---- settings sections (Settings → Супервизор and plugin sections) ----

  const sectionSources = () => ({
    paths: sinty.paths,
    config: sinty.config,
    policy: sinty.policy,
    plugins: [...sinty.host.plugins.values()].map((p) => ({ name: p.name, ...(p.loaded.manifest.settings ? { settings: p.loaded.manifest.settings } : {}), ...(p.loaded.manifest.config ? { config: p.loaded.manifest.config } : {}) })),
  });

  app.get("/v1/settings/sections", (c) => c.json({ sections: listSections(sectionSources()) }));

  app.put("/v1/settings/sections/:id", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { values?: unknown } | null;
    if (!body || !body.values || typeof body.values !== "object" || Array.isArray(body.values)) throw new AgentError("bad_request", "values is required");
    let saved: ReturnType<typeof saveSection>;
    try {
      saved = saveSection(sectionSources(), c.req.param("id"), body.values as Record<string, unknown>);
    } catch (e) {
      throw new AgentError("bad_request", e instanceof Error ? e.message : String(e));
    }
    if (c.req.param("id") === "memory") {
      // Live: the next compaction check and context snapshot read it.
      const cap = saved.config.memory.compactCapTokens;
      if (cap === undefined) delete sinty.config.memory.compactCapTokens;
      else sinty.config.memory.compactCapTokens = cap;
    } else if (c.req.param("id") === "supervisor") {
      // Live: the agent reads config.supervisor on every step; the supervisor process gets the new limits now.
      sinty.config.supervisor = saved.config.supervisor;
      sinty.supervisor?.setSettings(sinty.supervisorSettings());
    } else if (c.req.param("id") === "limits") {
      sinty.config.models.pluginTokensPerDay = saved.config.models.pluginTokensPerDay;
      sinty.config.models.maxOutputTokens = saved.config.models.maxOutputTokens;
      sinty.config.agent.taskMaxParallel = saved.config.agent.taskMaxParallel;
      sinty.config.agent.taskTreeTokens = saved.config.agent.taskTreeTokens;
    } else if (c.req.param("id") === "policy") {
      // Live: agent/host keep the same policy object; mutate in place so the next tool call sees it.
      assignPolicy(sinty.policy, saved.policy);
    } else {
      sinty.config.plugins.config = saved.config.plugins.config;
    }
    return c.json({ ok: true, restart: saved.restart, section: saved.section });
  });

  /** Lifecycle events of all sessions, live only; for lists, boards and badges. */
  app.get("/v1/stream", (c) =>
    sse(c, (push) =>
      sinty.bus.subscribe((m) => {
        if (m.kind === "journal" && OVERVIEW.has(m.event.type)) push(m.event);
      }),
      guard(c),
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
    if (!p || !ui?.static || p.loaded.manifest.editable !== false) return undefined;
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

interface StreamGuard {
  /** Whether the token the stream was opened with is still the login token. */
  valid: () => boolean;
  /** Registers a re-check to run right after a rotation; returns the unregister function. */
  register: (check: () => void) => () => void;
}

function sse(c: Context, subscribe: (push: (e: LiveEvent) => void) => () => void, guard: StreamGuard): Response {
  const queue: LiveEvent[] = [];
  let wake: (() => void) | undefined;
  let revoked = false;
  const unsubscribe = subscribe((e) => {
    queue.push(e);
    wake?.();
  });
  const check = () => {
    if (revoked || guard.valid()) return;
    revoked = true;
    wake?.();
  };
  const unregister = guard.register(check);
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => {
      unsubscribe();
      wake?.();
    });
    const ping = setInterval(() => {
      check();
      if (!revoked) void stream.writeSSE({ event: "ping", data: "{}" });
    }, 15_000);
    try {
      while (!stream.aborted && !revoked) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        wake = undefined;
        if (revoked) break;
        for (const e of queue.splice(0)) {
          await stream.writeSSE({ ...("seq" in e ? { id: String(e.seq) } : {}), event: e.type, data: JSON.stringify(e) });
        }
      }
      // The login token changed: say so and end the stream; the client's reconnect gets 401 with the old token.
      if (revoked && !stream.aborted) await stream.writeSSE({ event: "auth.revoked", data: "{}" });
    } finally {
      clearInterval(ping);
      unregister();
      unsubscribe();
    }
  });
}

function runSkillCommand(command: string, cwd: string): Promise<{ code: number; output: string }> {
  const line = command.trim();
  if (!line || line.length > 500) throw new AgentError("bad_request", "команда пустая или длиннее 500 символов");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(line, { shell: true, cwd, windowsHide: true });
    let output = "";
    const take = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.length > 8000) output = output.slice(-8000);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new AgentError("bad_request", e.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, output: output.trim() });
    });
  });
}

async function skillInstaller(bundledPlugins: string): Promise<{
  installSkillFiles(root: string, files: { path: string; data: Buffer }[]): { name: string; files: string[] };
  installSkillSource(root: string, source: string): { name: string; files: string[] };
  installSkillZip(root: string, zip: Buffer): { name: string; files: string[] };
}> {
  const file = join(bundledPlugins, "skills", "dist", "install.js");
  if (!existsSync(file)) throw new AgentError("bad_request", "плагин skills не собран");
  return import(pathToFileURL(file).href);
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
