import { spawn } from "node:child_process";
import { definePlugin, ToolError, z } from "@sinty/sdk";

const DEFAULTS: Record<string, string[]> = {
  claude: ["claude", "-p"],
  codex: ["codex", "exec"],
  grok: ["grok", "-p"],
};

export default definePlugin({
  name: "delegate",
  setup(ctx) {
    const commands = (ctx.config.commands ?? DEFAULTS) as Record<string, string[]>;
    ctx.tool({
      name: "delegate.run",
      description: "Give a whole task to another coding agent (claude, codex or grok) and wait for its final text. Does not share Sinty's tools.",
      input: z.object({
        program: z.string().min(1),
        prompt: z.string().min(1).max(100_000),
      }),
      sideEffects: "external",
      async run({ program, prompt }, { signal }) {
        const argv = commands[program];
        if (!argv?.length || argv.some((a) => typeof a !== "string" || !a)) {
          throw new ToolError("bad_program", `program ${program} is not configured`, { hint: `Allowed: ${Object.keys(commands).join(", ")}` });
        }
        const [bin, ...args] = argv;
        const text = await new Promise<string>((resolve, reject) => {
          const child = spawn(bin!, [...args, prompt], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          let err = "";
          const timer = setTimeout(() => child.kill(), Number(ctx.config.timeoutMs ?? 120_000));
          const stop = (): void => {
            child.kill();
          };
          signal.addEventListener("abort", stop, { once: true });
          child.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); });
          child.stderr.on("data", (c: Buffer) => { err += c.toString("utf8"); });
          child.on("error", (e) => {
            clearTimeout(timer);
            reject(new ToolError("delegate_failed", e.message, { hint: "Is the CLI installed and on PATH?" }));
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", stop);
            if (code === 0) resolve(out.trim());
            else reject(new ToolError("delegate_failed", err.slice(0, 500) || `exit ${code}`));
          });
        });
        return { content: text || "(no output)" };
      },
    });
  },
});
