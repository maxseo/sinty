import { readFile, stat } from "node:fs/promises";
import { definePlugin, ToolError, z, type PluginContext } from "@sinty/sdk";
import { isImageMime, resolveMime } from "./mime.ts";
import { buildPrompt, type VisionMode } from "./prompts.ts";
import { resolveImagePath } from "./path.ts";
import { readSettings, type VisionSettings } from "./settings.ts";

function isRouteMissing(e: unknown): boolean {
  return e instanceof ToolError && e.code === "route_missing";
}

/**
 * Prefer plugins.config.tool-vision.modelRoute; else models.routes.vision; else models.default.
 * permissions.models includes vision, default, and * (for provider/model overrides).
 */
async function completeVision(
  ctx: PluginContext,
  s: VisionSettings,
  messages: { role: "user"; content: string; images: { mime: string; data: string }[] }[],
  sessionId: string,
): Promise<{ text: string; route: string; provider: string; model: string }> {
  const reasoning = s.reasoning ? "medium" : "off";
  if (s.modelRoute) {
    const r = await ctx.models.complete({ route: s.modelRoute, messages, reasoning, sessionId });
    return { text: r.text, route: s.modelRoute, provider: r.provider, model: r.model };
  }
  try {
    const r = await ctx.models.complete({ route: "vision", messages, reasoning, sessionId });
    return { text: r.text, route: "vision", provider: r.provider, model: r.model };
  } catch (e) {
    if (!isRouteMissing(e)) throw e;
    const r = await ctx.models.complete({ route: "default", messages, reasoning, sessionId });
    return { text: r.text, route: "default", provider: r.provider, model: r.model };
  }
}

export default definePlugin({
  name: "tool-vision",
  setup(ctx) {
    const s = readSettings(ctx.config);
    const skills = ctx.paths.skills;
    const globalWorkspace = ctx.paths.workspace;

    ctx.tool({
      name: "vision.look",
      description:
        "Look at one or more image files under the workspace (or skills:…) with a vision model and return text (describe / OCR / find). Pass paths for a batch: the same prompt is sent with up to plugins.config.tool-vision.batch images per request (default 4). Do not use fs.read on PNG/JPEG/WebP for pixels. Needs an openai-compat vision route.",
      input: z
        .object({
          path: z.string().min(1).optional().describe('One file, relative to the workspace, or "skills:<path>"'),
          paths: z.array(z.string().min(1)).min(1).max(200).optional().describe("Several files. Same prompt, chunked by the Batch setting."),
          mode: z.enum(["describe", "ocr", "find"]).optional().describe("default describe"),
          prompt: z.string().optional().describe("Extra instructions; for find, what to look for. Applied to every image."),
        })
        .refine((v) => Boolean(v.path) || (v.paths && v.paths.length > 0), { message: "path or paths is required" }),
      sideEffects: "external",
      idempotent: true,
      timeoutMs: 900_000,
      async run({ path, paths, mode, prompt }, run) {
        const effectiveMode: VisionMode = mode ?? "describe";
        const wanted: string[] = [];
        for (const p of [...(path ? [path] : []), ...(paths ?? [])]) {
          if (!wanted.includes(p)) wanted.push(p);
        }
        const loaded: { shown: string; mime: string; bytes: Buffer }[] = [];
        for (const one of wanted) {
          const { abs, shown } = resolveImagePath(one, { workspace: run.workspace ?? globalWorkspace, skills });
          const info = await stat(abs).catch(() => undefined);
          if (!info) throw new ToolError("not_found", `${shown} does not exist`, { hint: "Use fs.list to see what is there." });
          if (info.isDirectory()) throw new ToolError("is_directory", `${shown} is a directory`, { hint: "Pass a file path to an image." });
          if (info.size > s.maxBytes) {
            throw new ToolError("too_large", `${shown} is ${info.size} bytes (limit ${s.maxBytes})`, {
              hint: "Shrink the image or raise plugins.config.tool-vision.maxImageMb (max 8).",
            });
          }
          const bytes = await readFile(abs);
          const mime = resolveMime(shown, bytes);
          if (!mime || !isImageMime(mime)) {
            throw new ToolError("not_image", `${shown} is not a supported image (got ${mime ?? "unknown"})`, {
              hint: "Supported: PNG, JPEG, GIF, WebP, BMP, TIFF. SVG and non-images use fs.read.",
            });
          }
          loaded.push({ shown, mime, bytes });
        }
        const batches: { paths: string[]; text: string }[] = [];
        let route = "";
        let provider = "";
        let model = "";
        for (let i = 0; i < loaded.length; i += s.batch) {
          const chunk = loaded.slice(i, i + s.batch);
          const shown = chunk.map((f) => f.shown);
          run.progress({ message: `looking at ${shown.join(", ")} (${effectiveMode}, ${chunk.length})` });
          let result: { text: string; route: string; provider: string; model: string };
          try {
            result = await completeVision(
              ctx,
              s,
              [{ role: "user", content: buildPrompt(effectiveMode, prompt, shown), images: chunk.map((f) => ({ mime: f.mime, data: f.bytes.toString("base64") })) }],
              run.sessionId,
            );
          } catch (e) {
            if (e instanceof ToolError) throw e;
            throw new ToolError("vision_failed", e instanceof Error ? e.message : String(e), {
              hint: "Check models.routes.vision (or models.default) points at an openai-compat vision model. Anthropic/Responses ignore images today.",
            });
          }
          const text = result.text.trim();
          if (!text) {
            throw new ToolError("empty_vision", `vision model returned empty text for ${shown.join(", ")}`, {
              hint: "The route may not support images, or the model refused. Try another models.routes.vision target or a smaller batch.",
            });
          }
          route = result.route;
          provider = result.provider;
          model = result.model;
          batches.push({ paths: shown, text });
        }
        const first = loaded[0]!;
        const text = batches.map((b) => b.text).join("\n\n");
        return {
          content: {
            ...(loaded.length === 1 ? { path: first.shown, mime: first.mime, bytes: first.bytes.byteLength } : {}),
            count: loaded.length,
            batchSize: s.batch,
            mode: effectiveMode,
            route,
            provider,
            model,
            images: loaded.map((f) => ({ path: f.shown, mime: f.mime, bytes: f.bytes.byteLength })),
            batches,
            text,
          },
        };
      },
    });
  },
});
