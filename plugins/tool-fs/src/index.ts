import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { definePlugin, ToolError, z } from "@sinty/sdk";
import { resolveFsPath } from "./resolve.ts";

const MAX_READ_BYTES = 2_000_000;

const FILE_TYPE: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function fileType(ext: string): string {
  return FILE_TYPE[ext] ?? "application/octet-stream";
}

const pathArg = z.string().min(1).describe('Relative to the workspace, or "skills:<path>" for the skills folder');

export default definePlugin({
  name: "tool-fs",
  setup(ctx) {
    const skills = ctx.paths.skills;
    const globalWorkspace = ctx.paths.workspace;
    const grants = new Map<string, { root: string; exp: number }>();
    const pageUrl = (root: string, shown: string): string => {
      const token = randomBytes(18).toString("base64url");
      grants.set(token, { root, exp: Date.now() + 4 * 60 * 60 * 1000 });
      const rel = (shown.startsWith("skills:") ? shown.slice("skills:".length) : shown).split("/").map(encodeURIComponent).join("/");
      return `/p/tool-fs/raw/${token}/${rel}`;
    };
    ctx.http({
      method: "GET",
      path: "/raw/:grant/*",
      public: true,
      async handler(_req, info) {
        const grant = grants.get(info.params.grant ?? "");
        if (!grant || grant.exp < Date.now()) return new Response("not found", { status: 404 });
        const parts: string[] = [];
        for (const part of (info.params["*"] ?? "").split("/")) {
          let decoded = "";
          try { decoded = decodeURIComponent(part); } catch { return new Response("not found", { status: 404 }); }
          if (!decoded || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return new Response("not found", { status: 404 });
          parts.push(decoded);
        }
        const rel = parts.join("/");
        if (!rel) return new Response("not found", { status: 404 });
        const abs = resolve(grant.root, rel);
        const root = grant.root.endsWith(sep) ? grant.root : grant.root + sep;
        let real = "";
        try { real = await realpath(abs); } catch { return new Response("not found", { status: 404 }); }
        const realRoot = (await realpath(grant.root).catch(() => grant.root));
        const realPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
        if (!(real === realRoot || real.startsWith(realPrefix)) || !(abs === grant.root || abs.startsWith(root))) return new Response("not found", { status: 404 });
        const infoStat = await stat(real);
        if (!infoStat.isFile()) return new Response("not found", { status: 404 });
        const type = fileType(extname(real).toLowerCase());
        return new Response(await readFile(real), {
          headers: {
            "content-type": type,
            "content-length": String(infoStat.size),
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
            "content-security-policy": "frame-ancestors 'self'",
            "access-control-allow-origin": "*",
            "referrer-policy": "no-referrer",
          },
        });
      },
    });

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

    const mediaExt = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg"]);
    const textMime: Record<string, string> = {
      ".md": "text/markdown",
      ".txt": "text/plain",
      ".log": "text/plain",
      ".json": "text/plain",
      ".csv": "text/plain",
      ".xml": "text/plain",
      ".css": "text/plain",
      ".svg": "image/svg+xml",
    };
    ctx.tool({
      name: "fs.preview",
      description: "Open a workspace file in the user's right-hand browser pane. Use for html, markdown, text, svg, pdf, images, video and audio the user should look at. Do not paste the file into the chat.",
      input: z.object({ path: pathArg }),
      sideEffects: "read",
      idempotent: true,
      async run({ path }, run) {
        const { abs, shown } = resolvePath(path, run.workspace ?? globalWorkspace);
        const info = await stat(abs).catch(() => undefined);
        if (!info) throw new ToolError("not_found", `${shown} does not exist`, { hint: "Use fs.list to see what is there." });
        if (!info.isFile()) throw new ToolError("is_directory", `${shown} is a directory`, { hint: "Preview a file, not a folder." });
        const ext = extname(shown).toLowerCase();
        const title = shown.split("/").pop() || shown;
        if (ext === ".html" || ext === ".htm") {
          const root = shown.startsWith("skills:") ? skills : (run.workspace ?? globalWorkspace);
          return { content: { preview: { title, path: shown, mime: "text/html", url: pageUrl(root, shown) } } };
        }
        if (mediaExt.has(ext)) return { content: { preview: { title, path: shown, mime: "media" } } };
        if (ext === ".pdf") {
          if (info.size > 1_500_000) throw new ToolError("too_large", `${shown} is ${info.size} bytes`, { hint: "Preview PDFs up to 1.5 MB." });
          return { content: { preview: { title, path: shown, mime: "application/pdf", text: (await readFile(abs)).toString("base64") } } };
        }
        const mime = textMime[ext];
        if (!mime) throw new ToolError("unsupported", `${shown} cannot be opened in the pane`, { hint: "html, md, txt, json, csv, svg, pdf, png, jpg, gif, webp, mp4, webm, mp3." });
        if (info.size > 200_000) throw new ToolError("too_large", `${shown} is ${info.size} bytes`, { hint: "Preview text files up to 200 KB." });
        return { content: { preview: { title, path: shown, mime, text: await readFile(abs, "utf8") } } };
      },
    });
    ctx.systemSection("fs-preview", () => "When the user should see a file (html, markdown, text, pdf, image, video), call fs.preview with its workspace path. The right-hand pane opens a browser tab. Do not paste that file into the chat.", { kind: "system", order: 30 });
  },
});
