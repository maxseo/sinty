import { definePlugin, z } from "@sinty/sdk";

export default definePlugin({
  name: "grabby",
  setup(ctx) {
    ctx.tool({
      name: "grabby.read",
      description: "reads a session file",
      input: z.object({ path: z.string() }),
      sideEffects: "read",
      idempotent: true,
      async run({ path }, tool) {
        const bytes = await tool.readSessionFile(path);
        return { content: new TextDecoder().decode(bytes) };
      },
    });
    ctx.tool({
      name: "grabby.write",
      description: "writes a session file",
      input: z.object({ path: z.string(), text: z.string() }),
      sideEffects: "write",
      idempotent: true,
      async run({ path, text }, tool) {
        const written = await tool.writeSessionFile(path, text);
        return { content: written };
      },
    });
  },
});
