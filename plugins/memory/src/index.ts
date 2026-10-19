import { join } from "node:path";
import { MemoryError, MemoryStore, renderMemoryBlock, type MemoryAbout, type MemoryScope, type MemoryTier } from "@sinty/core";
import { definePlugin, ToolError, z } from "@sinty/sdk";

const tier = z.enum(["profile", "log", "note"]);
const scope = z.enum(["user", "agent", "chat"]);
const about = z.enum(["user", "work"]);

export default definePlugin({
  name: "memory",
  setup(ctx) {
    const store = new MemoryStore(join(ctx.paths.data, "memory.db"), {
      userId: process.env.SINTY_USER_ID || "local",
      agentId: process.env.SINTY_AGENT_NAME || "Sinty",
      dimensions: Number(process.env.SINTY_MEMORY_DIM || 1536),
    });

    const fail = (e: unknown): never => {
      if (e instanceof MemoryError) throw new ToolError(e.code, e.message, e.hint ? { hint: e.hint } : {});
      throw e;
    };

    ctx.tool({
      name: "memory.write",
      description: "Store one self-contained sentence. profile is always in the prompt (max 40). log is a dated event. note expires in 14 days. To correct a fact, forget the old one and write the new one.",
      input: z.object({
        text: z.string().min(1),
        tier,
        scope,
        about,
        source: z.string().min(1).default("agent"),
      }),
      sideEffects: "write",
      idempotent: true,
      async run(args, run) {
        try {
          const saved = store.write({ ...args, source: args.source, ...(args.scope === "chat" ? { chatId: run.sessionId } : {}) });
          return { content: saved };
        } catch (e) {
          throw fail(e);
        }
      },
    });

    ctx.tool({
      name: "memory.forget",
      description: "Delete a fact by id or by its exact text.",
      input: z.object({ id: z.string().optional(), text: z.string().optional() }),
      sideEffects: "write",
      idempotent: true,
      async run(args) {
        try {
          return { content: { deleted: store.forget({ ...(args.id ? { id: args.id } : {}), ...(args.text ? { text: args.text } : {}) }) } };
        } catch (e) {
          throw fail(e);
        }
      },
    });

    ctx.tool({
      name: "memory.recall",
      description: "Search journal and notes for this user, this agent and this chat. Returns up to 15 facts with date and tier. Profile is not searched.",
      input: z.object({
        query: z.string().min(1),
        embedding: z.array(z.number()).max(4096).optional(),
      }),
      sideEffects: "read",
      idempotent: true,
      async run(args, run) {
        const embedding = args.embedding ? Float32Array.from(args.embedding) : undefined;
        const facts = store.recall({ query: args.query, chatId: run.sessionId, ...(embedding ? { embedding } : {}) });
        return {
          content: facts.map((f) => ({ id: f.id, tier: f.tier, scope: f.scope, date: f.createdAt.slice(0, 10), source: f.source, text: f.text })),
        };
      },
    });

    ctx.context("memory", async ({ sessionId, messages }) => {
      store.expire();
      const profile = store.profile();
      const logs = store.recentLog(10);
      const summary = store.getSummary(sessionId);
      const memory = { role: "system" as const, content: renderMemoryBlock(profile, logs) };
      const folded = summary ? [{ role: "system" as const, content: `<conversation_summary>\n${summary.text}\n</conversation_summary>` }] : [];
      const first = messages[0];
      if (first?.role === "system") return [first, memory, ...folded, ...messages.slice(1)];
      return [memory, ...folded, ...messages];
    });

  },
});

export type { MemoryAbout, MemoryScope, MemoryTier };
