import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, describeOutcome, runTurn, z } from "@sinty/sdk";

const body = z.object({
  text: z.string().optional(),
  message: z.string().optional(),
  session_id: z.string().optional(),
  chat_id: z.string().optional(),
  title: z.string().optional(),
}).loose();

class MapFile {
  private readonly file: string;
  private map: Record<string, string>;
  constructor(dir: string, name: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, name);
    this.map = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>) : {};
  }
  get(k: string): string | undefined { return this.map[k]; }
  set(k: string, v: string): void {
    this.map[k] = v;
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.map));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

export default definePlugin({
  name: "channel-webhook",
  setup(ctx) {
    const chats = new MapFile(ctx.paths.data, "chats.json");
    ctx.http({
      method: "POST",
      path: "/hook",
      async handler(req, { signal }) {
        const parsed = body.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
        const text = (parsed.data.text ?? parsed.data.message ?? "").trim();
        if (!text) return Response.json({ error: "text or message is required" }, { status: 400 });
        let sessionId = parsed.data.session_id;
        const chatId = parsed.data.chat_id;
        if (!sessionId && chatId) sessionId = chats.get(chatId);
        if (sessionId && !(await ctx.agent.getSession(sessionId))) sessionId = undefined;
        if (!sessionId) {
          sessionId = (await ctx.agent.createSession({ title: parsed.data.title ?? text.slice(0, 80), metadata: { via: "webhook", ...(chatId ? { chatId } : {}) } })).id;
          if (chatId) chats.set(chatId, sessionId);
        }
        const key = req.headers.get("idempotency-key") ?? undefined;
        const outcome = await runTurn(ctx.agent, sessionId, text, { signal, channel: "webhook", ...(key ? { idempotencyKey: key } : {}) });
        return Response.json({ session_id: sessionId, text: outcome.text, status: outcome.status, detail: describeOutcome(outcome, sessionId) }, { status: outcome.status === "failed" ? 502 : 200 });
      },
    });
  },
});
