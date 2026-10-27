import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSSE, definePlugin, ToolError, z, type AgentState, type PluginContext, type SSEWriter } from "@sinty/sdk";

const COLUMNS = [
  { id: "backlog", title: "Бэклог" },
  { id: "todo", title: "К выполнению" },
  { id: "doing", title: "В работе" },
  { id: "review", title: "Проверка" },
  { id: "done", title: "Готово" },
] as const;
type ColumnId = (typeof COLUMNS)[number]["id"];
const columnId = z.enum(COLUMNS.map((c) => c.id) as [ColumnId, ...ColumnId[]]);
const priorityId = z.enum(["high", "med", "low"]);
const notifyId = z.enum(["chat", "none"]);

interface Comment {
  by: "human" | "agent";
  text: string;
  at: string;
}

interface Activity {
  text: string;
  at: string;
}

interface Attachment {
  id: string;
  name: string;
  bytes: number;
}

interface Label {
  name: string;
  color: string;
}

interface Card {
  id: string;
  title: string;
  description: string;
  column: ColumnId;
  /** Roster agent id. Empty means nobody starts the card. */
  assigneeId: string | null;
  /** Roster agent id. Empty means the card waits in review for a person. */
  reviewerId: string | null;
  projectId?: string;
  /** Team chat that receives notes when notify is chat. */
  chatId: string | null;
  priority: "high" | "med" | "low";
  label: Label | null;
  /** Card ids that must be in Done before this one starts. */
  dependsOn: string[];
  /** Checkpoints for the worker and the reviewer. They do not hold the queue. */
  goals: { id: string; text: string; done: boolean }[];
  /** How the reviewer finishes: ask the human, send back to work, or accept. */
  reviewMode: "human" | "rework" | "accept";
  notify: "chat" | "none";
  result: string;
  activity: Activity[];
  attachments: Attachment[];
  /** Decomposition turn while the card is still in the backlog. */
  briefSessionId: string | null;
  sessionId: string | null;
  reviewSessionId: string | null;
  state: AgentState | null;
  runs: number;
  order: number;
  comments: Comment[];
  createdBy: "human" | "agent";
  createdAt: string;
  updatedAt: string;
}

interface Board {
  version: 1;
  cards: Card[];
}

function migrate(raw: Board): Board {
  for (const card of raw.cards ?? []) {
    const legacy = card as Card & { assignee?: string };
    if (!("assigneeId" in card)) legacy.assigneeId = legacy.assignee === "agent" ? null : null;
    delete legacy.assignee;
    card.reviewerId ??= null;
    card.chatId ??= null;
    card.priority ??= "med";
    card.label ??= null;
    card.dependsOn ??= [];
    card.goals ??= [];
    card.reviewMode ??= "human";
    card.briefSessionId ??= null;
    card.notify ??= "chat";
    card.reviewSessionId ??= null;
    card.description ??= "";
    card.comments ??= [];
    card.result ??= "";
    card.activity ??= [];
    card.attachments ??= [];
  }
  raw.version = 1;
  raw.cards ??= [];
  return raw;
}

class Store {
  private board: Board;
  private readonly file: string;
  private readonly watchers = new Set<SSEWriter>();

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "board.json");
    this.board = existsSync(this.file) ? migrate(JSON.parse(readFileSync(this.file, "utf8")) as Board) : { version: 1, cards: [] };
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

const labelInput = z.object({ name: z.string().min(1).max(40), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).nullable();

const createInput = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).default(""),
  column: columnId.default("backlog"),
  projectId: z.string().max(80).optional(),
  assigneeId: z.string().max(80).nullable().optional(),
  reviewerId: z.string().max(80).nullable().optional(),
  priority: priorityId.default("med"),
  label: labelInput.optional(),
  dependsOn: z.array(z.string()).max(50).default([]),
  goals: z.array(z.object({ id: z.string().max(40), text: z.string().min(1).max(500), done: z.boolean() })).max(30).default([]),
  reviewMode: z.enum(["human", "rework", "accept"]).default("human"),
  notify: notifyId.default("chat"),
  chatId: z.string().max(80).nullable().optional(),
  result: z.string().max(20_000).optional(),
});

const patchInput = createInput.partial().extend({
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

    const blockedBy = (card: Card): string[] =>
      card.dependsOn.filter((id) => store.cards.find((c) => c.id === id)?.column !== "done");

    const prompt = (card: Card): string =>
      [
        `Task from the kanban board, card ${card.id}: ${card.title}`,
        card.description && `\n${card.description}`,
        card.comments.length ? `\nComments:\n${card.comments.map((c) => `- ${c.by}: ${c.text}`).join("\n")}` : "",
        card.goals.length ? `\nCheckpoints:\n${card.goals.map((g) => `- [${g.done ? "x" : " "}] ${g.id} ${g.text}`).join("\n")}` : "",
        "\nDo the whole card. Mark a checkpoint done with kanban.update goals when you reach it. When you finish, give a short summary. The board moves a finished turn to review.",
        card.notify === "chat" ? "Notes you add with kanban.update are copied into the team chat." : "This card's notifications are off: do not expect the team chat to see your notes.",
      ]
        .filter(Boolean)
        .join("\n");

    async function teamChat(card: Card): Promise<string | null> {
      if (card.chatId) return card.chatId;
      if (!card.projectId) return null;
      const sessions = await ctx.agent.listSessions({ limit: 200 });
      const mine = sessions.filter((s) => s.projectId === card.projectId && !s.metadata?.parentSessionId && !s.metadata?.kanbanCard);
      mine.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      return mine[0]?.id ?? null;
    }

    async function handBacklog(card: Card): Promise<void> {
      if (card.column !== "backlog" || !card.assigneeId) return;
      try {
        if (!card.briefSessionId) {
          const s = await ctx.agent.createSession({
            title: `Разбор: ${card.title}`,
            ...(card.projectId ? { projectId: card.projectId } : {}),
            metadata: { kanbanCard: card.id, kanbanRole: "brief", agentIds: [card.assigneeId] },
          });
          card.briefSessionId = s.id;
          touch(card);
          store.save();
        }
        await ctx.agent.send(
          card.briefSessionId,
          [
            `Backlog card ${card.id}: ${card.title}`,
            card.description && `\n${card.description}`,
            "\nYou are the assignee, usually the project lead. The card stays in backlog.",
            "If the task needs results from smaller pieces, kanban.create one child per piece in column todo, with its assigneeId, reviewerId, and dependsOn when the pieces are sequential.",
            "Then kanban.update this card: keep only the final step in the description, set dependsOn to those children, set reviewerId, and move column to todo. Do not start it. It waits until every child is done.",
            "If it does not split, set reviewerId and goals when they help, then move this same card to todo.",
            "A card in todo does not start until it has a reviewer who is not the assignee and every dependency is done.",
          ]
            .filter(Boolean)
            .join("\n"),
          { idempotencyKey: `${card.id}:brief:${card.assigneeId}` },
        );
      } catch (e) {
        ctx.log.warn("backlog brief failed", e instanceof Error ? e.message : e);
      }
    }

    async function announce(card: Card, text: string): Promise<void> {
      if (card.notify !== "chat") return;
      try {
        const chat = await teamChat(card);
        if (!chat) return;
        card.chatId = chat;
        await ctx.agent.send(chat, `[Канбан #${card.id} · ${card.title}] ${text}`);
      } catch (e) {
        ctx.log.warn("kanban note failed", e instanceof Error ? e.message : e);
      }
    }

    async function start(card: Card): Promise<void> {
      if (!card.assigneeId || blockedBy(card).length) return;
      if (card.state === "working" || card.state === "blocked") return;
      if (!card.sessionId) {
        const s = await ctx.agent.createSession({
          title: card.title,
          ...(card.projectId ? { projectId: card.projectId } : {}),
          metadata: { kanbanCard: card.id, agentIds: [card.assigneeId] },
        });
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

    async function startReview(card: Card): Promise<void> {
      if (!card.reviewerId || card.reviewerId === card.assigneeId || card.reviewSessionId) return;
      const s = await ctx.agent.createSession({
        title: `Проверка: ${card.title}`,
        ...(card.projectId ? { projectId: card.projectId } : {}),
        metadata: { kanbanCard: card.id, kanbanRole: "review", agentIds: [card.reviewerId] },
      });
      card.reviewSessionId = s.id;
      touch(card);
      store.save();
      const last = [...card.comments].reverse().find((c) => c.by === "agent");
      await ctx.agent.send(
        s.id,
        [
          `Review kanban card ${card.id}: ${card.title}`,
          card.description && `\n${card.description}`,
          last ? `\nWorker note:\n${last.text}` : "",
          card.goals.length ? `\nCheckpoints:\n${card.goals.map((g) => `- [${g.done ? "x" : " "}] ${g.text}`).join("\n")}` : "",
          `\nYou are the reviewer, not the author. Do not do the task yourself. reviewMode is ${card.reviewMode}.`,
          card.reviewMode === "accept"
            ? "If the result meets the checkpoints, kanban.update column to done with a short comment. If not, move it to doing and write what is missing."
            : card.reviewMode === "rework"
              ? "Do not accept it. Move the card to doing and write what must be redone."
              : "Do not move the card to done. Write a review comment that a person can check. The human accepts the card.",
        ]
          .filter(Boolean)
          .join("\n"),
        { idempotencyKey: `${card.id}:review:${card.runs}` },
      );
    }

    function pump(): Promise<void> {
      pumping = pumping.then(async () => {
        for (;;) {
          const busy = store.cards.filter((c) => c.column === "doing" && (c.state === "working" || c.state === "blocked")).length;
          if (busy >= maxParallel) return;
          const ready = (c: Card): boolean => !!c.assigneeId && !!c.reviewerId && c.reviewerId !== c.assigneeId && blockedBy(c).length === 0 && c.state !== "working" && c.state !== "blocked";
          const doing = store.cards.filter((c) => c.column === "doing" && ready(c)).sort((a, b) => a.order - b.order)[0];
          const next = doing ?? store.cards.filter((c) => c.column === "todo" && ready(c)).sort((a, b) => a.order - b.order)[0];
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
      card.state = null;
      card.activity.push({ text: "doing → review", at: now() });
      touch(card);
      store.save();
      void announce(card, "Задача на проверке.");
      void startReview(card).catch((err: unknown) => ctx.log.warn("review start failed", err instanceof Error ? err.message : err));
      void pump();
    });

    registerTools(ctx, store, now, touch, pump, blockedBy, announce, handBacklog);

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
          const input = createInput.parse(await req.json());
          const column = input.column === "doing" ? "todo" : input.column;
          const card = blank(store, input, column, "human", now);
          store.cards.push(card);
          store.save();
          if (card.column === "backlog" && card.assigneeId) await handBacklog(card);
          await pump();
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
          const input = patchInput.parse(await req.json());
          const from = card.column;
          const beforeAssignee = card.assigneeId;
          applyPatch(card, input, now);
          if (input.column !== undefined && input.column !== from) {
            card.column = input.column;
            card.order = input.order ?? store.nextOrder(input.column);
            card.activity.push({ text: `${from} → ${input.column}`, at: now() });
            if (input.column === "todo" || input.column === "doing") {
              card.reviewSessionId = null;
              if (card.state === "done" || card.state === "error") card.state = null;
            }
          } else if (input.order !== undefined) card.order = input.order;
          const assigneeChanged = !!card.assigneeId && card.assigneeId !== beforeAssignee;
          touch(card);
          store.save();
          const toWork = card.column === "doing" && from !== "doing";
          if (from === "doing" && card.column !== "doing" && card.sessionId && (card.state === "working" || card.state === "blocked")) {
            await ctx.agent.interrupt(card.sessionId);
          } else if (toWork) await start(card);
          if (input.comment && card.notify === "chat") await announce(card, input.comment);
          if (card.column === "backlog" && assigneeChanged) await handBacklog(card);
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
          if (card.sessionId && (card.state === "working" || card.state === "blocked")) await ctx.agent.interrupt(card.sessionId);
          store.cards.splice(store.cards.indexOf(card), 1);
          for (const other of store.cards) other.dependsOn = other.dependsOn.filter((id) => id !== card.id);
          store.save();
          return new Response(null, { status: 204 });
        } catch (e) {
          return fail(e);
        }
      },
    });

    void pump();

    const filesDir = (cardId: string): string => join(ctx.paths.data, "files", cardId);
    const safeName = (name: string): string => name.replace(/[^\w.\- ()\u0400-\u04FF]+/g, "_").slice(0, 120) || "file";

    ctx.http({
      method: "POST",
      path: "/cards/:id/files",
      async handler(req, { params }) {
        try {
          const card = store.find(params.id!);
          const form = await req.formData();
          const file = form.get("file");
          if (!(file instanceof File)) return json({ error: { code: "bad_request", message: "file is required" } }, 400);
          if (file.size > 25 * 1024 * 1024) return json({ error: { code: "too_large", message: "file is over 25 MB" } }, 400);
          const id = randomUUID().slice(0, 8);
          const name = safeName(file.name);
          const dir = filesDir(card.id);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${id}-${name}`), Buffer.from(await file.arrayBuffer()));
          card.attachments.push({ id, name, bytes: file.size });
          card.activity.push({ text: `Файл ${name}`, at: now() });
          touch(card);
          store.save();
          return json(card);
        } catch (e) {
          return fail(e);
        }
      },
    });

    ctx.http({
      method: "GET",
      path: "/cards/:id/files/:file",
      handler(_req, { params }) {
        const card = store.cards.find((c) => c.id === params.id);
        const att = card?.attachments.find((a) => a.id === params.file);
        if (!card || !att) return json({ error: { code: "not_found", message: "file not found" } }, 404);
        const path = join(filesDir(card.id), `${att.id}-${safeName(att.name)}`);
        if (!existsSync(path)) return json({ error: { code: "not_found", message: "file not found" } }, 404);
        return new Response(readFileSync(path), { headers: { "content-disposition": `attachment; filename="${encodeURIComponent(att.name)}"` } });
      },
    });

    ctx.http({
      method: "DELETE",
      path: "/cards/:id/files/:file",
      handler(_req, { params }) {
        try {
          const card = store.find(params.id!);
          const att = card.attachments.find((a) => a.id === params.file);
          if (!att) throw new ToolError("not_found", "file not found");
          const path = join(filesDir(card.id), `${att.id}-${safeName(att.name)}`);
          if (existsSync(path)) unlinkSync(path);
          card.attachments = card.attachments.filter((a) => a.id !== att.id);
          touch(card);
          store.save();
          return json(card);
        } catch (e) {
          return fail(e);
        }
      },
    });
  },
});

function blank(store: Store, input: z.infer<typeof createInput>, column: ColumnId, createdBy: "human" | "agent", now: () => string): Card {
  return {
    id: randomUUID().slice(0, 8),
    title: input.title,
    description: input.description,
    column,
    assigneeId: input.assigneeId ?? null,
    reviewerId: input.reviewerId ?? null,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    chatId: input.chatId ?? null,
    priority: input.priority,
    label: input.label ?? null,
    dependsOn: input.dependsOn.filter((id) => id !== "" && store.cards.some((c) => c.id === id)),
    goals: input.goals,
    reviewMode: input.reviewMode,
    notify: input.notify,
    result: input.result ?? "",
    activity: [{ text: `Создана в ${column}`, at: now() }],
    attachments: [],
    briefSessionId: null,
    sessionId: null,
    reviewSessionId: null,
    state: null,
    runs: 0,
    order: store.nextOrder(column),
    comments: [],
    createdBy,
    createdAt: now(),
    updatedAt: now(),
  };
}

function applyPatch(card: Card, input: z.infer<typeof patchInput>, now: () => string, by: "human" | "agent" = "human"): void {
  if (input.title !== undefined) card.title = input.title;
  if (input.description !== undefined) card.description = input.description;
  if (input.assigneeId !== undefined) card.assigneeId = input.assigneeId;
  if (input.reviewerId !== undefined) card.reviewerId = input.reviewerId;
  if (input.priority !== undefined) card.priority = input.priority;
  if (input.label !== undefined) card.label = input.label;
  if (input.dependsOn !== undefined) card.dependsOn = input.dependsOn.filter((id) => id !== card.id);
  if (input.goals !== undefined) card.goals = input.goals;
  if (input.reviewMode !== undefined) card.reviewMode = input.reviewMode;
  if (input.notify !== undefined) card.notify = input.notify;
  if (input.chatId !== undefined) card.chatId = input.chatId;
  if (input.result !== undefined) card.result = input.result;
  if (input.comment) card.comments.push({ by, text: input.comment, at: now() });
}

function registerTools(
  ctx: PluginContext,
  store: Store,
  now: () => string,
  touch: (c: Card) => void,
  pump: () => Promise<void>,
  blockedBy: (c: Card) => string[],
  announce: (c: Card, text: string) => Promise<void>,
  handBacklog: (c: Card) => Promise<void>,
): void {
  const brief = (c: Card): Record<string, unknown> => ({
    id: c.id,
    title: c.title,
    column: c.column,
    assigneeId: c.assigneeId,
    reviewerId: c.reviewerId,
    projectId: c.projectId ?? null,
    priority: c.priority,
    label: c.label?.name ?? null,
    dependsOn: c.dependsOn,
    waitingOn: blockedBy(c),
    notify: c.notify,
    state: c.state,
    comments: c.comments.length,
  });

  ctx.tool({
    name: "kanban.list",
    description: "List kanban cards, or one card with its description and comments. Columns: backlog, todo, doing, review, done. waitingOn lists dependencies that are not done yet; those cards do not start.",
    input: z.object({ column: columnId.optional(), projectId: z.string().optional(), id: z.string().optional() }),
    sideEffects: "read",
    idempotent: true,
    async run({ column, projectId, id }) {
      if (id) return { content: store.find(id) };
      return {
        content: store.snapshot().cards.filter((c) => (!column || c.column === column) && (!projectId || c.projectId === projectId)).map(brief),
      };
    },
  });

  ctx.tool({
    name: "kanban.create",
    description: "Create a card. A backlog card with assigneeId asks that agent to decompose or send it to todo. Children of a split belong in todo with their own assigneeId, reviewerId, and dependsOn. A card does not start until its reviewer is set and every dependency is done.",
    input: createInput,
    sideEffects: "write",
    async run(input) {
      const column = input.column === "doing" || input.column === "done" ? "backlog" : input.column;
      const card = blank(store, input, column, "agent", now);
      store.cards.push(card);
      store.save();
      if (card.column === "backlog" && card.assigneeId) await handBacklog(card);
      return { content: brief(card) };
    },
  });

  ctx.tool({
    name: "kanban.update",
    description: "Update a card: comment, assignee, reviewer, reviewMode (human, rework, accept), goals, dependencies, or column. Assigning a backlog card asks that agent to decompose it; the column stays backlog. The author cannot move the card to done. reviewMode human or rework cannot be moved to done by the reviewer. Moving a running card out of doing interrupts it.",
    input: patchInput.extend({ id: z.string() }),
    sideEffects: "write",
    async run(input, call) {
      const card = store.find(input.id);
      if (input.column === "done" && card.sessionId && call.sessionId === card.sessionId) {
        throw new ToolError("not_allowed", "the author does not accept their own card", { hint: "Leave it in review." });
      }
      if (input.column === "done" && card.reviewMode !== "accept" && call.sessionId === card.reviewSessionId) {
        throw new ToolError("not_allowed", "this review mode does not accept the card", {
          hint: card.reviewMode === "human" ? "Write the review comment and leave the card in review for the human." : "Move the card to doing with a comment.",
        });
      }
      const from = card.column;
      const beforeAssignee = card.assigneeId;
      applyPatch(card, input, now, "agent");
      if (input.column && input.column !== from) {
        card.column = input.column;
        card.order = store.nextOrder(input.column);
        card.activity.push({ text: `${from} → ${input.column}`, at: now() });
      }
      const assigneeChanged = !!card.assigneeId && card.assigneeId !== beforeAssignee;
      if ((card.column === "doing" || card.column === "todo") && card.column !== from) card.reviewSessionId = null;
      touch(card);
      store.save();
      if (from === "doing" && card.column !== "doing" && card.sessionId && (card.state === "working" || card.state === "blocked")) {
        await ctx.agent.interrupt(card.sessionId);
      }
      if (input.comment) await announce(card, input.comment);
      if (card.column === "review" && from !== "review") await announce(card, "Задача на проверке.");
      if (card.column === "backlog" && assigneeChanged) await handBacklog(card);
      await pump();
      return { content: brief(card) };
    },
  });
}
