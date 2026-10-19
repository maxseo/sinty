import { z, type EventType, type LiveEvent, type SessionInfo } from "@sinty/sdk";
import { AgentError, type Agent } from "./agent.js";
import type { Bus } from "./bus.js";
import type { AgentBridge } from "./host/host.js";
import type { AgentOp } from "./host/protocol.js";
import type { Journal, SessionRow } from "./journal.js";

const id = z.string().min(1).max(100);
const ARGS: Record<AgentOp, z.ZodType<unknown[]>> = {
  listSessions: z.tuple([z.object({ limit: z.number().int().min(1).max(500).optional() }).optional()]),
  getSession: z.tuple([id]),
  events: z.tuple([id, z.object({ afterSeq: z.number().int().min(0).optional(), types: z.array(z.string()).optional(), limit: z.number().int().min(1).max(5000).optional() }).optional()]),
  createSession: z.tuple([
    z.object({ title: z.string().max(300).optional(), projectId: z.string().max(100).optional(), metadata: z.record(z.string(), z.unknown()).optional() }).optional(),
  ]),
  send: z.tuple([id, z.string().min(1).max(200_000), z.object({ idempotencyKey: z.string().max(200).optional(), channel: z.string().max(100).optional() }).optional()]),
  interrupt: z.tuple([id]),
};

export function sessionInfo(journal: Journal, s: SessionRow): SessionInfo {
  const t = journal.activeTurn(s.id);
  return { ...s, activeTurn: t ? { id: t.id, status: t.status as "running" | "blocked" } : null };
}

/** Journal events after `afterSeq`, then live bus events for the session, without duplicates. */
export function liveEvents(journal: Journal, bus: Bus, sessionId: string, afterSeq: number, push: (e: LiveEvent) => void): () => void {
  if (!journal.getSession(sessionId)) throw new AgentError("not_found", `session ${sessionId} not found`, 404);
  let last = afterSeq;
  for (const e of journal.events(sessionId, { afterSeq })) {
    push(e);
    last = e.seq;
  }
  return bus.subscribe((m) => {
    if (m.event.sessionId !== sessionId) return;
    if (m.kind === "journal") {
      if (m.event.seq <= last) return;
      last = m.event.seq;
    }
    push(m.event);
  });
}

export function createAgentBridge(get: () => { agent: Agent; journal: Journal; bus: Bus }): AgentBridge {
  return {
    async call(plugin, op, raw) {
      const parsed = ARGS[op]?.safeParse(raw);
      if (!parsed?.success) throw new AgentError("invalid_args", parsed ? z.prettifyError(parsed.error) : `unknown op ${op}`);
      const a = parsed.data as [never, never, never];
      const { agent, journal } = get();
      const actor = { kind: "plugin" as const, id: plugin };
      switch (op) {
        case "listSessions": {
          const o = (a[0] ?? {}) as { limit?: number };
          return journal.listSessions(o.limit ?? 100).map((s) => sessionInfo(journal, s));
        }
        case "getSession": {
          const s = journal.getSession(a[0]);
          return s ? sessionInfo(journal, s) : null;
        }
        case "events": {
          const sessionId: string = a[0];
          if (!journal.getSession(sessionId)) throw new AgentError("not_found", `session ${sessionId} not found`, 404);
          const o = (a[1] ?? {}) as { afterSeq?: number; types?: EventType[]; limit?: number };
          return journal.events(sessionId, o);
        }
        case "createSession": {
          const o = (a[0] ?? {}) as { title?: string; projectId?: string; metadata?: Record<string, unknown> };
          return sessionInfo(journal, agent.createSession({ ...o, metadata: { ...o.metadata, createdBy: plugin } }));
        }
        case "send": {
          const o = (a[2] ?? {}) as { idempotencyKey?: string; channel?: string };
          return agent.send(a[0], a[1], { idempotencyKey: o.idempotencyKey ? `${plugin}:${o.idempotencyKey}` : undefined, channel: o.channel ?? plugin, actor });
        }
        case "interrupt":
          return agent.interrupt(a[0], actor);
      }
    },
    stream(sessionId, afterSeq, push) {
      const { journal, bus } = get();
      return liveEvents(journal, bus, sessionId, afterSeq, push);
    },
  };
}
