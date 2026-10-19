import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "@sinty/sdk";

export default definePlugin({
  name: "web-routes",
  setup(ctx) {
    ctx.http({
      method: "GET",
      path: "/echo/:name",
      handler(req, { params }) {
        const url = new URL(req.url);
        return Response.json({
          name: params.name,
          query: Object.fromEntries(url.searchParams),
          authorization: req.headers.get("authorization"),
          cookie: req.headers.get("cookie"),
          custom: req.headers.get("x-custom"),
        });
      },
    });
    ctx.http({ method: "GET", path: "/public", public: true, handler: () => new Response("open") });
    ctx.http({
      method: "GET",
      path: "/stream",
      handler() {
        const enc = new TextEncoder();
        const body = new ReadableStream({
          async start(c) {
            for (const part of ["one ", "two ", "three"]) {
              c.enqueue(enc.encode(part));
              await new Promise((r) => setTimeout(r, 20));
            }
            c.close();
          },
        });
        return new Response(body, { headers: { "content-type": "text/plain", "x-from": "plugin" } });
      },
    });
    ctx.http({
      method: "POST",
      path: "/files/*",
      async handler(req, { params }) {
        mkdirSync(ctx.paths.data, { recursive: true });
        writeFileSync(join(ctx.paths.data, "note.txt"), await req.text());
        return Response.json({ rest: params["*"] ?? null, dataDir: ctx.paths.data });
      },
    });
    ctx.http({ method: "GET", path: "/sessions", handler: async () => Response.json(await ctx.agent.listSessions({ limit: 10 })) });
    ctx.http({
      method: "POST",
      path: "/create",
      async handler() {
        try {
          await ctx.agent.createSession({ title: "nope" });
          return Response.json({ ok: true });
        } catch (e) {
          return Response.json({ ok: false, code: e.code, message: e.message }, { status: 403 });
        }
      },
    });
    ctx.http({
      method: "GET",
      path: "/boom",
      handler() {
        throw new Error("handler exploded");
      },
    });
  },
});
