import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, runTurn } from "@sinty/sdk";

interface Update {
  message?: { chat?: { id?: number }; text?: string };
}

class Chats {
  private readonly file: string;
  private map: Record<string, string>;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "chats.json");
    this.map = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>) : {};
  }
  get(id: string): string | undefined { return this.map[id]; }
  set(id: string, session: string): void {
    this.map[id] = session;
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.map));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

export default definePlugin({
  name: "channel-telegram",
  setup(ctx) {
    const chats = new Chats(ctx.paths.data);
    const api = String(ctx.config.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "");

    ctx.http({
      method: "POST",
      path: "/telegram",
      public: true,
      async handler(req, { signal }) {
        const expected = await ctx.secrets.get("telegram.secret").catch(() => "");
        if (!expected || req.headers.get("x-telegram-bot-api-secret-token") !== expected) {
          return new Response("unauthorized", { status: 401 });
        }
        const update = (await req.json().catch(() => ({}))) as Update;
        const text = update.message?.text?.trim();
        const chatId = update.message?.chat?.id;
        if (!text || chatId === undefined) return Response.json({ ok: true, ignored: true });

        const key = String(chatId);
        let sessionId = chats.get(key);
        if (!sessionId || !(await ctx.agent.getSession(sessionId))) {
          sessionId = (await ctx.agent.createSession({ title: `telegram ${key}`, metadata: { via: "telegram", chatId: key } })).id;
          chats.set(key, sessionId);
        }
        try {
          const outcome = await runTurn(ctx.agent, sessionId, text, { signal, channel: "telegram", idempotencyKey: `tg:${key}:${text.slice(0, 40)}` });
          const token = await ctx.secrets.get("telegram.bot").catch(() => "");
          let delivered = false;
          if (token && outcome.text) {
            const res = await ctx.net.fetch(`${api}/bot${token}/sendMessage`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text: outcome.text.slice(0, 4000) }),
              signal,
            });
            delivered = res.ok;
          }
          return Response.json({ ok: true, session_id: sessionId, status: outcome.status, delivered });
        } catch (e) {
          return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
        }
      },
    });
  },
});
