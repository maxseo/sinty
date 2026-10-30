import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { definePlugin, ToolError, z } from "@sinty/sdk";
import { acceptFromEditor, callTool, cloudCall, takeInbox } from "./host.js";

const COMMANDS = ["open", "context", "capture", "check", "export", "probe", "grab", "transcribe", "filmstrip", "waveform", "listen", "fonts", "logs", "screenshot", "window", "job", "generate"] as const;
const LONG = new Set(["export", "transcribe", "listen", "grab", "generate"]);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function cors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  headers.set("cross-origin-resource-policy", "cross-origin");
  return new Response(res.body, { status: res.status, headers });
}

function editorFile(rel: string): Response {
  const root = resolve(process.cwd(), "editor");
  const clean = normalize(decodeURIComponent(rel || "index.html")).replace(/^([/\\])+/, "");
  let file = resolve(root, clean);
  const relToRoot = relative(root, file);
  if (relToRoot.startsWith("..") || isAbsolute(relToRoot)) return new Response("not found", { status: 404 });
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(clean)) return new Response("not found", { status: 404 });
    file = join(root, "index.html");
    if (!existsSync(file)) return new Response("редактор ещё не собран", { status: 404 });
  }
  const ext = extname(file).toLowerCase();
  const headers: Record<string, string> = {
    "content-type": TYPES[ext] ?? "application/octet-stream",
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=300",
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
  };
  if (ext === ".html") {
    headers["cross-origin-opener-policy"] = "same-origin";
    headers["cross-origin-embedder-policy"] = "credentialless";
  }
  return new Response(readFileSync(file), { headers });
}

export default definePlugin({
  name: "diffusion",
  setup(ctx) {
    const roots = () => ({ workspace: ctx.paths.workspace, data: ctx.paths.data });
    const json = (body: unknown, code = 200) => cors(new Response(JSON.stringify(body), {
      status: code,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    }));

    ctx.http({ method: "GET", path: "/app", public: true, surface: "status", handler: () => editorFile("index.html") });
    ctx.http({
      method: "GET",
      path: "/app/*",
      public: true,
      surface: "status",
      handler: (_req, info) => editorFile(info.params["*"] ?? "index.html"),
    });
    ctx.http({
      method: "GET",
      path: "/ipc/inbox",
      public: true,
      surface: "status",
      handler: () => json(takeInbox()),
    });
    ctx.http({
      method: "*",
      path: "/ipc/out",
      public: true,
      surface: "status",
      handler: async (req) => {
        if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
        if (req.method !== "POST") return json({ error: { message: "нужен POST" } }, 405);
        const body = await req.json() as { channel?: string; payload?: unknown };
        if (!body.channel) return json({ error: { message: "нет канала" } }, 400);
        await acceptFromEditor(body.channel, body.payload, roots());
        return json({ ok: true });
      },
    });
    ctx.http({
      method: "*",
      path: "/api/call",
      public: true,
      surface: "status",
      handler: async (req) => {
        if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
        if (req.method !== "POST") return json({ error: { message: "нужен POST" } }, 405);
        const body = await req.json() as { path?: string; input?: unknown };
        try {
          return json({ result: await cloudCall(ctx.paths.data, body.path ?? "", body.input) });
        } catch (error) {
          return json({ error: { message: error instanceof Error ? error.message : "не подключено" } }, 400);
        }
      },
    });

    ctx.tool({
      name: "diffusion.run",
      description: "Run one editor command in the Diffusion tab: open, context, capture, check, export, probe, grab, transcribe, filmstrip, waveform, listen, fonts, logs, screenshot, window, job. The tab has to be open. Paths stay in the session workspace.",
      sideEffects: "external",
      input: z.object({
        command: z.enum(COMMANDS),
        args: z.array(z.string()).default([]),
      }),
      async run(input) {
        const args = argsOf(input.command, input.args);
        const ms = LONG.has(input.command) ? 600_000 : 180_000;
        try {
          return { content: await callTool(input.command, args, ms) };
        } catch (error) {
          throw new ToolError("diffusion_run", error instanceof Error ? error.message : "команда не выполнилась");
        }
      },
    });

    ctx.tool({
      name: "diffusion.generate",
      description: "Generate media through the connected model adapter. Asks first. Without an address in adapters.json the call answers that nothing is connected.",
      sideEffects: "external",
      input: z.object({ args: z.array(z.string()).default([]) }),
      async run(input) {
        try {
          return { content: await callTool("generate", argsOf("generate", input.args), 600_000) };
        } catch (error) {
          throw new ToolError("diffusion_generate", error instanceof Error ? error.message : "не подключено");
        }
      },
    });
  },
});

function argsOf(command: string, args: string[]): Record<string, unknown> {
  if (command === "open") {
    const dir = args.find((arg) => !arg.startsWith("-"));
    if (!dir) throw new ToolError("diffusion_arg", "нужна папка проекта");
    return { dir };
  }
  const record: Record<string, unknown> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--prompt" || arg === "-p") record.prompt = args[++i] ?? "";
    else if (arg === "--start" || arg === "-s") record.start = Number(args[++i]);
    else if (arg === "--end" || arg === "-e") record.end = Number(args[++i]);
    else if (!arg.startsWith("-")) rest.push(arg);
  }
  if (rest[0]) record.path = rest[0];
  if (rest.length > 1) record.output = rest[1];
  return record;
}
