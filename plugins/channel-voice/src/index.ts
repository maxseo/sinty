import { definePlugin, runTurn, z } from "@sinty/sdk";

const body = z.object({ text: z.string().min(1), session_id: z.string().optional() });

export default definePlugin({
  name: "channel-voice",
  setup(ctx) {
    ctx.http({
      method: "POST",
      path: "/turn",
      async handler(req, { signal }) {
        const parsed = body.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
        let sessionId = parsed.data.session_id;
        if (!sessionId || !(await ctx.agent.getSession(sessionId))) {
          sessionId = (await ctx.agent.createSession({ title: parsed.data.text.slice(0, 80), metadata: { via: "voice" } })).id;
        }
        const outcome = await runTurn(ctx.agent, sessionId, parsed.data.text, { signal, channel: "voice" });
        return Response.json({ session_id: sessionId, text: outcome.text, status: outcome.status });
      },
    });
  },
});
