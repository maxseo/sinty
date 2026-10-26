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
  const max = s.maxOutputTokens;
  if (s.modelRoute) {
    const r = await ctx.models.complete({ route: s.modelRoute, messages, maxOutputTokens: max, sessionId });
    return { text: r.text, route: s.modelRoute, provider: r.provider, model: r.model };
  }
  try {
    const r = await ctx.models.complete({ route: "vision", messages, maxOutputTokens: max, sessionId });
    return { text: r.text, route: "vision", provider: r.provider, model: r.model };
  } catch (e) {
    if (!isRouteMissing(e)) throw e;
    const r = await ctx.models.complete({ route: "default", messages, maxOutputTokens: max, sessionId });
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
        "Look at an image file under the workspace (or skills:…) with a vision model and return a text description / OCR / find result. Do not use fs.read on PNG/JPEG/WebP for pixels — call this instead. Needs an openai-compat vision route (models.routes.vision or models.default).",
      input: z.object({
        path: z.string().min(1).describe('Relative to the workspace, or "skills:<path>"'),
        mode: z.enum(["describe", "ocr", "find"]).optional().describe("default describe"),
        prompt: z.string().optional().describe("Extra instructions; for find, what to look for"),
      }),
      sideEffects: "external",
      idempotent: true,
      timeoutMs: 180_000,
      async run({ path, mode, prompt }, run) {
        const effectiveMode: VisionMode = mode ?? "describe";
        const { abs, shown } = resolveImagePath(path, { workspace: run.workspace ?? globalWorkspace, skills });
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
        run.progress({ message: `looking at ${shown} (${effectiveMode})` });
        const userText = buildPrompt(effectiveMode, prompt);
        let result: { text: string; route: string; provider: string; model: string };
        try {
          result = await completeVision(
            ctx,
            s,
            [{ role: "user", content: userText, images: [{ mime, data: bytes.toString("base64") }] }],
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
          throw new ToolError("empty_vision", "vision model returned empty text", {
            hint: "The route may not support images, or the model refused. Try another models.routes.vision target.",
          });
        }
        return {
          content: {
            path: shown,
            mime,
            bytes: bytes.byteLength,
            mode: effectiveMode,
            route: result.route,
            provider: result.provider,
            model: result.model,
            text,
          },
        };
      },
    });
  },
});
