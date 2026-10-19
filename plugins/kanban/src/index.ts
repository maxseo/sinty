import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSSE, definePlugin, ToolError, z, type AgentState, type PluginContext, type SSEWriter } from "@sinty/sdk";

const COLUMNS = [
  { id: "backlog", title: "Backlog" },
  { id: "todo", title: "To do" },
  { id: "doing", title: "In progress" },
  { id: "review", title: "Review" },
  { id: "done", title: "Done" },
] as const;
type ColumnId = (typeof COLUMNS)[number]["id"];
const columnId = z.enum(COLUMNS.map((c) => c.id) as [ColumnId, ...ColumnId[]]);

interface Comment {
  by: "human" | "agent";
  text: string;
  at: string;
}

interface Card {
  id: string;
  title: string;
  description: string;
  column: ColumnId;
  /** Only `agent` cards are started automatically; only a human can assign a card to the agent. */
  assignee: "agent" | "human";
  sessionId: string | null;
  state: AgentState | null;
  runs: number;
  order: number;
  comments: Comment[];
  createdBy: "human" | "agent";
  createdAt: string;
  updatedAt: string;
  /** Which project this card belongs to. The board itself stays shared. */
  projectId?: string;
}

interface Board {
  version: 1;
  cards: Card[];
}

class Store {
  private board: Board;
  private readonly file: string;
  private readonly watchers = new Set<SSEWriter>();

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "board.json");
    this.board = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Board) : { version: 1, cards: [] };
  }

  get cards(): Card[] {
    return this.board.cards;
  }

  find(id: string): Card {
    const card = this.board.cards.find((c) => c.id === id);
    if (!card) throw new ToolError("not_found", `card ${id} not found`, { hint: "Use kanban.list to see card ids." });
    return card;
  }

  snapshot(): { columns: typeof COLUMNS; cards: Card[] } {
    return { columns: COLUMNS, cards: [...this.board.cards].sort((a, b) => a.order - b.order) };
  }

  /** Atomic write: a crash leaves the old or the new file, never half of one. */
  save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.board, null, 2));
    renameSync(tmp, this.file);
    const snap = this.snapshot();
    for (const w of this.watchers) if (!w.send(snap, { event: "board" })) this.watchers.delete(w);
  }

  watch(w: SSEWriter): void {
    this.watchers.add(w);
    w.send(this.snapshot(), { event: "board" });
  }

  nextOrder(column: ColumnId): number {
    return Math.max(0, ...this.board.cards.filter((c) => c.column === column).map((c) => c.order)) + 1;
  }
}

const createInput = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).default(""),
  column: columnId.default("backlog"),
  projectId: z.string().max(80).optional(),
});

const humanCreate = createInput.extend({ assignee: z.enum(["agent", "human"]).default("human") });
const humanPatch = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
  column: columnId.optional(),
  projectId: z.string().max(80).optional(),
  assignee: z.enum(["agent", "human"]).optional(),
  order: z.number().optional(),
  comment: z.string().min(1).max(5000).optional(),
});

export default definePlugin({
  name: "kanban",
  setup(ctx) {
    const store = new Store(ctx.paths.data);
    const maxParallel = Number(ctx.config.maxParallel ?? 3);
    let pumping = Promise.resolve();

    const now = (): string => new Date().toISOString();
    const touch = (card: Card): void => {
      card.updatedAt = now();
    };

    const prompt = (card: Card): string =>
      [
        `Task from the kanban board, card ${card.id}: ${card.title}`,
        card.description && `\n${card.description}`,
        card.comments.length ? `\nComments:\n${card.comments.map((c) => `- ${c.by}: ${c.text}`).join("\n")}` : "",
        "\nWork on it. When you finish, give a short summary of the result. Use kanban.update to add a comment if something is unclear.",
      ]
        .filter(Boolean)
        .join("\n");

    async function start(card: Card): Promise<void> {
      if (!card.sessionId) {
        const s = await ctx.agent.createSession({ title: card.title, metadata: { kanbanCard: card.id } });
        card.sessionId = s.id;
      }
      card.runs++;
      card.column = "doing";
      card.state = "working";
      touch(card);
      store.save();
      try {
        await ctx.agent.send(card.sessionId, card.runs === 1 ? prompt(card) : `The card was moved back to work.\n\n${prompt(card)}`, { idempotencyKey: `${card.id}:${card.runs}` });
      } catch (e) {
        card.state = "error";
        card.comments.push({ by: "agent", text: `Could not start: ${e instanceof Error ? e.message : String(e)}`, at: now() });
        store.save();
      }
    }

    /** Starts queued agent cards while there are free slots. */
    function pump(): Promise<void> {
      pumping = pumping.then(async () => {
        for (;;) {
          const busy = store.cards.filter((c) => c.column === "doing" && (c.state === "working" || c.state === "blocked")).length;
          if (busy >= maxParallel) return;
          const next = store.cards.filter((c) => c.column === "todo" && c.assignee === "agent").sort((a, b) => a.order - b.order)[0];
          if (!next) return;
          await start(next);
        }
      });
      return pumping.catch((e: unknown) => ctx.log.error("pump failed", e instanceof Error ? e.message : e));
    }

    function bySession(sessionId: string): Card | undefined {
      return store.cards.find((c) => c.sessionId === sessionId);
    }

    ctx.on("agent.state", (e) => {
      const card = bySession(e.sessionId);
      if (!card) return;
      card.state = e.data.state;
      touch(card);
      store.save();
      if (e.data.state !== "working" && e.data.state !== "blocked") void pump();
    });

    ctx.on("turn.completed", (e) => {
      const card = bySession(e.sessionId);
      if (!card || card.column !== "doing") return;
      card.column = "review";
      card.order = store.nextOrder("review");
      touch(card);
      store.save();
      void pump();
    });

    registerTools(ctx, store, now, touch, pump);

    // ---- HTTP for the Web UI ----

    const json = (data: unknown, status = 200): Response => Response.json(data, { status });
    const fail = (e: unknown): Response => {
      if (e instanceof ToolError) return json({ error: { code: e.code, message: e.message } }, e.code === "not_found" ? 404 : 400);
      if (e instanceof z.ZodError) return json({ error: { code: "bad_request", message: z.prettifyError(e) } }, 400);
      throw e;
    };

    ctx.http({ method: "GET", path: "/board", handler: () => json(store.snapshot()) });

    ctx.http({
      method: "GET",
      path: "/stream",
      handler(_req, { signal }) {
        const w = createSSE(signal);
        store.watch(w);
        return w.response;
      },
    });

    ctx.http({
      method: "POST",
      path: "/cards",
      async handler(req) {
        try {
          const input = humanCreate.parse(await req.json());
          const card: Card = {
            id: randomUUID().slice(0, 8),
            title: input.title,
            description: input.description,
            column: input.column,
            assignee: input.assignee,
            sessionId: null,
            state: null,
            runs: 0,
            order: store.nextOrder(input.column),
            comments: [],
            createdBy: "human",
            createdAt: now(),
            updatedAt: now(),
            ...(input.projectId ? { projectId: input.projectId } : {}),
          };
          store.cards.push(card);
          store.save();
          if (card.assignee === "agent" && (card.column === "todo" || card.column === "doing")) {
            if (card.column === "doing") await start(card);
            else await pump();
          }
          return json(card, 201);
        } catch (e) {
          return fail(e);
        }
      },
    });

    ctx.http({
      method: "PATCH",
      path: "/cards/:id",
      async handler(req, { params }) {
        try {
          const card = store.find(params.id!);
          const input = humanPatch.parse(await req.json());
          const from = card.column;
          if (input.title !== undefined) card.title = input.title;
          if (input.description !== undefined) card.description = input.description;
          if (input.assignee !== undefined) card.assignee = input.assignee;
          if (input.projectId !== undefined) card.projectId = input.projectId;
          if (input.comment) card.comments.push({ by: "human", text: input.comment, at: now() });
          if (input.column !== undefined && input.column !== from) {
            card.column = input.column;
            card.order = input.order ?? store.nextOrder(input.column);
          } else if (input.order !== undefined) card.order = input.order;
          touch(card);
          store.save();
          const toWork = card.assignee === "agent" && card.column === "doing" && from !== "doing";
          if (toWork) await start(card);
          else if (from === "doing" && card.column !== "doing" && card.sessionId && card.state === "working") await ctx.agent.interrupt(card.sessionId);
          else if (input.comment && card.sessionId && card.column === "review" && card.assignee === "agent") {
            card.column = "todo";
            card.order = store.nextOrder("todo");
            store.save();
          }
          await pump();
          return json(card);
        } catch (e) {
          return fail(e);
        }
      },
    });

    ctx.http({
      method: "DELETE",
      path: "/cards/:id",
      async handler(_req, { params }) {
        try {
          const card = store.find(params.id!);
          if (card.sessionId && card.state === "working") await ctx.agent.interrupt(card.sessionId);
          store.cards.splice(store.cards.indexOf(card), 1);
          store.save();
          return new Response(null, { status: 204 });
        } catch (e) {
          return fail(e);
        }
      },
    });

    ctx.http({
      method: "POST",
      path: "/cards/:id/start",
      async handler(_req, { params }) {
        try {
          const card = store.find(params.id!);
          card.assignee = "agent";
          await start(card);
          return json(card);
        } catch (e) {
          return fail(e);
        }
      },
    });

    void pump();
  },
});

function registerTools(ctx: PluginContext, store: Store, now: () => string, touch: (c: Card) => void, pump: () => Promise<void>): void {
  const brief = (c: Card): Record<string, unknown> => ({ id: c.id, title: c.title, column: c.column, assignee: c.assignee, state: c.state, comments: c.comments.length });

  ctx.tool({
    name: "kanban.list",
    description: "List kanban cards, optionally in one column. Columns: backlog, todo, doing, review, done.",
    input: z.object({ column: columnId.optional(), id: z.string().optional().describe("return one card with description and comments") }),
    sideEffects: "read",
    idempotent: true,
    async run({ column, id }) {
      if (id) return { content: store.find(id) };
      return { content: store.snapshot().cards.filter((c) => !column || c.column === column).map(brief) };
    },
  });

  ctx.tool({
    name: "kanban.create",
    description: "Create a card for the human or for later. Cards you create are assigned to the human; only a human can hand a card to the agent.",
    input: createInput,
    sideEffects: "write",
    async run(input) {
      const card: Card = {
        id: randomUUID().slice(0, 8),
        title: input.title,
        description: input.description,
        column: input.column === "doing" ? "todo" : input.column,
        assignee: "human",
        sessionId: null,
        state: null,
        runs: 0,
        order: store.nextOrder(input.column),
        comments: [],
        createdBy: "agent",
        createdAt: now(),
        updatedAt: now(),
      };
      store.cards.push(card);
      store.save();
      return { content: brief(card) };
    },
  });

  ctx.tool({
    name: "kanban.update",
    description: "Comment on a card or move it. Use a comment to report progress or ask a question; move your own card to review when the task is done.",
    input: z.object({ id: z.string(), column: columnId.optional(), comment: z.string().min(1).max(5000).optional() }),
    sideEffects: "write",
    async run({ id, column, comment }, { sessionId }) {
      const card = store.find(id);
      if (column === "doing" || (column === "todo" && card.assignee === "agent" && card.sessionId !== sessionId)) {
        throw new ToolError("not_allowed", "only a human can start work on a card", { hint: "Add a comment instead; the human decides what runs." });
      }
      if (comment) card.comments.push({ by: "agent", text: comment, at: now() });
      if (column && column !== card.column) {
        card.column = column;
        card.order = store.nextOrder(column);
      }
      touch(card);
      store.save();
      await pump();
      return { content: brief(card) };
    },
  });
}
