import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { definePlugin, ToolError, z } from "@sinty/sdk";
import { resolveFsPath } from "./resolve.ts";

const MAX_READ_BYTES = 2_000_000;

const pathArg = z.string().min(1).describe('Relative to the workspace, or "skills:<path>" for the skills folder');

export default definePlugin({
  name: "tool-fs",
  setup(ctx) {
    const skills = ctx.paths.skills;
    const globalWorkspace = ctx.paths.workspace;

    const resolvePath = (p: string, workspace = globalWorkspace) => resolveFsPath(p, { workspace, skills });

    ctx.tool({
      name: "fs.read",
      description: "Read a UTF-8 text file. Returns numbered lines; use offset/limit for large files.",
      input: z.object({
        path: pathArg,
        offset: z.number().int().min(1).optional().describe("first line, 1-based"),
        limit: z.number().int().min(1).max(5000).optional(),
      }),
      sideEffects: "read",
      idempotent: true,
      async run({ path, offset, limit }, run) {
        const { abs, shown } = resolvePath(path, run.workspace ?? globalWorkspace);
        const info = await stat(abs).catch(() => undefined);
        if (!info) throw new ToolError("not_found", `${shown} does not exist`, { hint: "Use fs.list to see what is there." });
        if (info.isDirectory()) throw new ToolError("is_directory", `${shown} is a directory`, { hint: "Use fs.list for directories." });
        if (info.size > MAX_READ_BYTES) throw new ToolError("too_large", `${shown} is ${info.size} bytes`, { hint: "Read a range with offset and limit." });
        const lines = (await readFile(abs, "utf8")).split(/\r?\n/);
        const start = (offset ?? 1) - 1;
        const end = Math.min(lines.length, start + (limit ?? 2000));
        const body = lines
          .slice(start, end)
          .map((l, i) => `${String(start + i + 1).padStart(6)}|${l}`)
          .join("\n");
        return { content: { path: shown, totalLines: lines.length, from: start + 1, to: end, text: body } };
      },
    });

    ctx.tool({
      name: "fs.list",
      description: "List a directory (non-recursive by default).",
      input: z.object({ path: pathArg.optional(), depth: z.number().int().min(1).max(5).optional() }),
      sideEffects: "read",
      idempotent: true,
      async run({ path, depth }, run) {
        const { abs, shown } = resolvePath(path ?? ".", run.workspace ?? globalWorkspace);
        const out: string[] = [];
        const walk = async (dir: string, level: number): Promise<void> => {
          const entries = await readdir(dir, { withFileTypes: true }).catch(() => {
            throw new ToolError("not_found", `${shown} does not exist or is not a directory`);
          });
          for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const rel = relative(abs, join(dir, e.name)).split(sep).join("/");
            out.push(e.isDirectory() ? `${rel}/` : rel);
            if (out.length >= 2000) return;
            if (e.isDirectory() && level < (depth ?? 1)) await walk(join(dir, e.name), level + 1);
          }
        };
        await walk(abs, 1);
        return { content: { path: shown, entries: out, truncated: out.length >= 2000 } };
      },
    });

    ctx.tool({
      name: "fs.write",
      description: "Create or overwrite a text file. Parent folders are created.",
      input: z.object({ path: pathArg, content: z.string() }),
      sideEffects: "write",
      idempotent: true,
      async run({ path, content }, run) {
        const { abs, shown } = resolvePath(path, run.workspace ?? globalWorkspace);
        await mkdir(dirname(abs), { recursive: true });
        const tmp = `${abs}.sinty-tmp`;
        await writeFile(tmp, content, "utf8");
        await rename(tmp, abs);
        return { content: { path: shown, bytes: Buffer.byteLength(content) } };
      },
    });

    ctx.tool({
      name: "fs.edit",
      description: "Replace an exact, unique fragment of a text file. Fails if the fragment is missing or not unique.",
      input: z.object({ path: pathArg, old: z.string().min(1), new: z.string(), replaceAll: z.boolean().optional() }),
      sideEffects: "write",
      idempotent: false,
      async run(args, run) {
        const { abs, shown } = resolvePath(args.path, run.workspace ?? globalWorkspace);
        const text = await readFile(abs, "utf8").catch(() => {
          throw new ToolError("not_found", `${shown} does not exist`);
        });
        const count = text.split(args.old).length - 1;
        if (count === 0) throw new ToolError("no_match", `fragment not found in ${shown}`, { hint: "Read the file again; whitespace must match exactly." });
        if (count > 1 && !args.replaceAll) throw new ToolError("not_unique", `fragment occurs ${count} times in ${shown}`, { hint: "Include more surrounding text or set replaceAll." });
        const next = args.replaceAll ? text.split(args.old).join(args.new) : text.replace(args.old, () => args.new);
        await writeFile(abs, next, "utf8");
        return { content: { path: shown, replaced: args.replaceAll ? count : 1 } };
      },
    });
  },
});
