import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { definePlugin, ToolError, z, type MemoryWrite, type TurnInfo } from "@sinty/sdk";
import { EXTRACT_PROMPT, parseClaims } from "./extract.js";
import { MemoryV1Store, localDay, rememberLine, type RememberInput } from "./store.js";
import type { Mode, Policy } from "./policy.js";

const kind = z.enum(["person", "preference", "fact", "decision", "question"]);
const rel = z.enum(["supports", "contradicts", "continues"]);

const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public", "graph.html"), "utf8");

function userOf(req: Request): string | Response {
  const id = req.headers.get("x-sinty-user-id")?.trim();
  if (!id) return Response.json({ error: { code: "AGENT_MEMORY_SCOPE_DENIED", message: "the host did not say which user this request belongs to" } }, { status: 403 });
  return id;
}

export default definePlugin({
  name: "memory-v1",
  setup(ctx) {
    const store = new MemoryV1Store(join(ctx.paths.data, "memory-v1.db"));
    const turns = new Map<string, TurnInfo>();

    const identity = async (sessionId: string): Promise<TurnInfo> => {
      const turn = turns.get(sessionId);
      if (!turn) throw new ToolError("AGENT_MEMORY_UNAVAILABLE", "this turn has no memory context yet");
      const session = await ctx.agent.getSession(sessionId);
      if (session?.metadata && typeof session.metadata.parentSessionId === "string") {
        throw new ToolError("AGENT_MEMORY_SCOPE_DENIED", "a child task cannot write long-term memory");
      }
      return turn;
    };

    ctx.memory.provider({
      name: "memory-v1",
      async recall(q) {
        const turn = q.turn;
        if (!turn?.userId || !turn.agentId) return [];
        try {
          if (!q.query.trim()) {
          const here = { sessionId: turn.sessionId, ...(turn.projectId ? { projectId: turn.projectId } : {}) };
          return store.prompt(turn.userId, turn.agentId, 40, here).map((claim) => ({ id: claim.id, text: claim.text, provider: "memory-v1", tier: "profile" as const, scope: claim.home === "chat" ? "chat" as const : claim.home === "user" ? "user" as const : "agent" as const, ref: claim.kind, score: claim.salience }));
        }
        return store.search(turn.userId, turn.agentId, { sessionId: turn.sessionId, ...(turn.projectId ? { projectId: turn.projectId } : {}) }, q.query || turn.text, q.limit ?? 12)
            .map((claim) => ({ id: claim.id, text: claim.text, provider: "memory-v1", scope: claim.home === "chat" ? "chat" as const : claim.home === "user" ? "user" as const : "agent" as const, score: claim.match, ref: claim.id }));
        } catch (error) {
          ctx.log.warn("memory-v1 recall failed", error instanceof Error ? error.message : error);
          return [];
        }
      },
      async write(w: MemoryWrite & { userId?: string }) {
        const userId = w.userId || process.env.SINTY_USER_ID || "local";
        const saved = store.remember({
          userId,
          agentId: w.agentId,
          sessionId: w.chatId || "memory",
          text: w.text,
          kind: w.tier === "profile" || w.about === "user" ? "preference" : "fact",
          basis: "agent_inferred",
          evidenceId: w.source || "memory.write",
          quote: w.text.slice(0, 1000),
          opKey: `core:${userId}:${w.agentId}:${w.text}`,
        });
        return { id: saved.id, action: saved.action === "inserted" ? "inserted" as const : "updated" as const };
      },
      async forget(f) {
        const userId = process.env.SINTY_USER_ID || "local";
        if (!f.id) return { deleted: 0 };
        const row = store.findClaim(userId, f.id);
        if (!row) return { deleted: 0 };
        try {
          store.close(userId, row.agentId, f.id, `forget:${f.id}`);
          return { deleted: 1 };
        } catch {
          return { deleted: 0 };
        }
      },
    });

    ctx.memory.processor({
      name: "memory-v1",
      order: 40,
      async onTurnStart(turn) {
        turns.set(turn.sessionId, turn);
        if (!turn.text.trim()) return;
        return { queries: [turn.text], limit: 12, providers: ["memory-v1"] };
      },
      async afterTurn({ turn, messages }) {
        const session = await ctx.agent.getSession(turn.sessionId);
        if (session?.metadata && typeof session.metadata.parentSessionId === "string") return {};
        const said = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n").trim();
        if (!said) return {};
        const save = (text: string, kind: "person" | "preference" | "fact" | "decision" | "question", basis: "user_requested" | "agent_inferred", opKey: string, quote: string, subject?: string): void => {
          store.remember({
            userId: turn.userId,
            agentId: turn.agentId,
            sessionId: turn.sessionId,
            ...(turn.projectId ? { projectId: turn.projectId } : {}),
            text,
            kind,
            ...(subject ? { subject } : {}),
            basis,
            evidenceId: turn.turnId || turn.sessionId,
            quote,
            sourceText: said,
            opKey,
          });
        };
        const explicit = rememberLine(said);
        if (explicit) {
          try { save(explicit, "fact", "user_requested", `after:${turn.turnId || turn.sessionId}:explicit`, explicit); }
          catch (error) { ctx.log.warn("memory-v1 skipped an explicit remember line", error instanceof Error ? error.message : error); }
        }
        try {
          const reply = await ctx.models.complete({
            route: "cheap",
            maxOutputTokens: 400,
            sessionId: turn.sessionId,
            messages: [{ role: "user", content: `${EXTRACT_PROMPT}\n\nUser said:\n${said.slice(-6000)}` }],
          });
          parseClaims(reply.text).forEach((claim, index) => {
            try { save(claim.text, claim.kind, "agent_inferred", `after:${turn.turnId || turn.sessionId}:${index}`, claim.quote); }
            catch (error) { ctx.log.warn("memory-v1 skipped an inferred claim", error instanceof Error ? error.message : error); }
          });
        } catch (error) {
          ctx.log.warn("memory-v1 could not read the turn for memory", error instanceof Error ? error.message : error);
        }
        return {};
      },
    });

    ctx.tool({
      name: "memory_v1.remember",
      description: "Save one short claim for this user and agent. The host sets who owns it and which chat it belongs to. Do not put secrets here.",
      input: z.object({
        text: z.string().min(1).max(500),
        kind,
        basis: z.enum(["user_requested", "agent_inferred"]).default("agent_inferred"),
        evidenceId: z.string().min(1).max(200),
        quote: z.string().max(1000).default(""),
        links: z.array(z.object({ to: z.string(), rel })).max(8).optional(),
      }),
      sideEffects: "write",
      idempotent: false,
      async run(args, call) {
        const turn = await identity(call.sessionId);
        const input: RememberInput = {
          userId: turn.userId,
          agentId: turn.agentId,
          sessionId: turn.sessionId,
          ...(turn.projectId ? { projectId: turn.projectId } : {}),
          text: args.text,
          kind: args.kind,
          basis: args.basis,
          evidenceId: args.evidenceId,
          quote: args.quote || args.text,
          opKey: call.idempotencyKey,
          ...(args.links ? { links: args.links } : {}),
        };
        try {
          return { content: store.remember(input) };
        } catch (error) {
          throw new ToolError(codeOf(error), error instanceof Error ? error.message : "memory write failed");
        }
      },
    });

    ctx.tool({
      name: "memory_v1.search",
      description: "Search this agent's claims that the current chat is allowed to recall.",
      input: z.object({ query: z.string().min(1).max(500) }),
      sideEffects: "read",
      idempotent: true,
      async run(args, call) {
        const turn = turns.get(call.sessionId);
        if (!turn) throw new ToolError("AGENT_MEMORY_UNAVAILABLE", "this turn has no memory context yet");
        const rows = store.search(turn.userId, turn.agentId, { sessionId: turn.sessionId, ...(turn.projectId ? { projectId: turn.projectId } : {}) }, args.query);
        return { content: { claims: rows.map((row) => ({ id: row.id, text: row.text, kind: row.kind, home: row.home })) } };
      },
    });

    ctx.tool({
      name: "memory_v1.close",
      description: "Mark one current claim as no longer true. It stays in the store and on the graph.",
      input: z.object({ id: z.string().regex(/^mem_[a-f0-9]+$/) }),
      sideEffects: "write",
      idempotent: false,
      async run(args, call) {
        const turn = await identity(call.sessionId);
        try {
          return { content: store.close(turn.userId, turn.agentId, args.id, call.idempotencyKey) };
        } catch (error) {
          throw new ToolError(codeOf(error), error instanceof Error ? error.message : "memory close failed");
        }
      },
    });

    ctx.http({
      method: "GET",
      path: "/graph",
      public: true,
      surface: "graph",
      handler() {
        return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    });

    ctx.http({
      method: "GET",
      path: "/api/graph",
      surface: "graph",
      handler(req) {
        const user = userOf(req);
        if (user instanceof Response) return user;
        const url = new URL(req.url, "http://sinty.local");
        const agentId = url.searchParams.get("agentId") ?? "";
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(agentId)) return Response.json({ error: { code: "bad_request", message: "agentId is required" } }, { status: 400 });
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const projectId = url.searchParams.get("projectId") ?? undefined;
        return Response.json(store.graph(user, agentId, { sessionId, ...(projectId ? { projectId } : {}) }));
      },
    });

    ctx.http({
      method: "POST",
      path: "/api/policy",
      surface: "graph",
      access: "edit",
      async handler(req) {
        const user = userOf(req);
        if (user instanceof Response) return user;
        const body = await req.json() as { agentId?: string; mode?: Mode; aboutUser?: boolean; projectWork?: boolean; otherProjects?: boolean; night?: boolean; researchAtNight?: boolean; researchPrompt?: string };
        if (!body.agentId || !/^[A-Za-z0-9_-]{1,80}$/.test(body.agentId)) return Response.json({ error: { code: "bad_request", message: "agentId is required" } }, { status: 400 });
        const current = store.policy(user, body.agentId);
        const next: Policy = {
          mode: body.mode === "chat" || body.mode === "project" || body.mode === "agent" ? body.mode : current.mode,
          aboutUser: typeof body.aboutUser === "boolean" ? body.aboutUser : current.aboutUser,
          projectWork: typeof body.projectWork === "boolean" ? body.projectWork : current.projectWork,
          otherProjects: typeof body.otherProjects === "boolean" ? body.otherProjects : current.otherProjects,
          night: typeof body.night === "boolean" ? body.night : current.night,
          researchAtNight: typeof body.researchAtNight === "boolean" ? body.researchAtNight : current.researchAtNight,
          researchPrompt: typeof body.researchPrompt === "string" ? body.researchPrompt : current.researchPrompt,
        };
        return Response.json({ policy: store.setPolicy(user, body.agentId, next) });
      },
    });

    const dreamOne = async (userId: string, agentId: string): Promise<{ day: string; summary: string }> => {
      const policy = store.policy(userId, agentId);
      const day = localDay();
      const cards = store.graph(userId, agentId, { sessionId: "" }).nodes.filter((card) => localDay(card.touchedAt) === day && !card.validTo);
      const lines = cards.map((card) => `- [${card.kind}] ${card.text}`).join("\n") || "(за день новых карточек нет)";
      const research = policy.researchAtNight && policy.researchPrompt.trim()
        ? `\n\nResearch hint. Do not invent sources. If the cards are not enough, say what a later web search should check:\n${policy.researchPrompt.trim().slice(0, 2000)}`
        : "";
      let summary = lines;
      try {
        const reply = await ctx.models.complete({
          route: "cheap",
          maxOutputTokens: 700,
          messages: [{ role: "user", content: `Write a short day note in the user's language from these memory cards of ${day}. Keep names, decisions and open questions. Do not add facts that are not in the list.${research}\n\n${lines}` }],
        });
        summary = reply.text.trim().slice(0, 4000) || lines;
      } catch (error) {
        ctx.log.warn("memory-v1 night pass kept the raw card list", error instanceof Error ? error.message : error);
      }
      store.saveDay(userId, agentId, day, summary, policy.researchAtNight);
      return { day, summary };
    };

    ctx.http({
      method: "POST",
      path: "/api/dream",
      surface: "graph",
      access: "edit",
      async handler(req) {
        const user = userOf(req);
        if (user instanceof Response) return user;
        const body = await req.json() as { agentId?: string };
        if (!body.agentId || !/^[A-Za-z0-9_-]{1,80}$/.test(body.agentId)) return Response.json({ error: { code: "bad_request", message: "agentId is required" } }, { status: 400 });
        return Response.json(await dreamOne(user, body.agentId));
      },
    });

    ctx.http({
      method: "GET",
      path: "/api/days",
      surface: "graph",
      handler(req) {
        const user = userOf(req);
        if (user instanceof Response) return user;
        const agentId = new URL(req.url, "http://sinty.local").searchParams.get("agentId") ?? "";
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(agentId)) return Response.json({ error: { code: "bad_request", message: "agentId is required" } }, { status: 400 });
        return Response.json({ days: store.timeline(user, agentId) });
      },
    });

    let lastNight = "";
    const nightTick = async (): Promise<void> => {
      const hour = new Date().getHours();
      const day = localDay();
      if (hour !== 4 || lastNight === day) return;
      lastNight = day;
      for (const pair of store.agentsForNight()) {
        try { await dreamOne(pair.userId, pair.agentId); }
        catch (error) { ctx.log.warn("memory-v1 night pass failed", error instanceof Error ? error.message : error); }
      }
    };
    const timer = setInterval(() => void nightTick(), 15 * 60 * 1000);
    if (typeof timer.unref === "function") timer.unref();
  },
});

function codeOf(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  return code || "AGENT_MEMORY_UNAVAILABLE";
}
